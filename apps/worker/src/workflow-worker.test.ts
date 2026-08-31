import { describe, expect, it, vi } from 'vitest';
import {
  runSnapshotFingerprintMaterial,
  type RunJobData,
  type RunSnapshot,
  type WorkflowState,
} from '@multimodal-canvas/domain';
import { createHash } from 'node:crypto';

type StubJob = {
  id: string;
  data: Record<string, unknown>;
  updateData(data: Record<string, unknown>): Promise<void>;
  updateProgress(progress: unknown): Promise<void>;
};

const bullmqState = vi.hoisted(() => ({
  jobs: new Map<string, StubJob>(),
  processor: undefined as ((job: StubJob) => Promise<unknown>) | undefined,
}));

vi.mock('bullmq', () => {
  class Queue {
    constructor(..._args: unknown[]) {}
  }

  class Worker {
    constructor(_name: string, processor: (job: StubJob) => Promise<unknown>) {
      bullmqState.processor = processor;
    }
  }

  class Job {
    static async fromId(_queue: unknown, id: string) {
      return bullmqState.jobs.get(id);
    }
  }

  return { Job, Queue, Worker };
});

import { createProviderJobRecord, createRunWorker } from './index';
import {
  createInitialWorkflowState,
  replaceWorkflowNodeState,
  workflowNodeState,
  workflowSnapshotFingerprint,
  workflowSnapshotFingerprintV1,
} from './workflow-dag';

const projectId = '123e4567-e89b-42d3-a456-426614174100';
const credentialId = '123e4567-e89b-42d3-a456-426614174199';

async function getTestProviderCredentials() {
  return {
    baseUrl: 'https://newapi.example/v1',
    apiKey: 'synthetic-test-key',
  };
}

const snapshot: RunSnapshot = {
  projectId,
  canvasRevision: 7,
  targetNodeId: 'node_video',
  modelAlias: 'video-default',
  credentialId,
  credentialVersion: 1,
  parameters: { resolution: '1080p' },
  submittedAt: '2026-08-27T00:00:00.000Z',
  nodes: [
    {
      id: 'node_prompt',
      type: 'text',
      position: { x: 0, y: 0 },
      data: {
        label: 'Prompt source',
        mediaType: 'text',
        mode: 'source',
        prompt: 'A city at sunrise',
        assetId: 'asset_prompt',
        contentUrl: 'data:text/plain,A%20city%20at%20sunrise',
        mimeType: 'text/plain',
      },
    },
    {
      id: 'node_draft',
      type: 'text',
      position: { x: 200, y: 0 },
      data: {
        label: 'Draft prompt',
        mediaType: 'text',
        mode: 'transform',
        modelAlias: 'text-model',
      },
    },
    {
      id: 'node_style',
      type: 'image',
      position: { x: 0, y: 200 },
      data: {
        label: 'Style reference',
        mediaType: 'image',
        mode: 'source',
        assetId: 'asset_style',
        contentUrl: 'https://assets.example/style.png',
        mimeType: 'image/png',
      },
    },
    {
      id: 'node_image',
      type: 'image',
      position: { x: 220, y: 200 },
      data: {
        label: 'Key frame',
        mediaType: 'image',
        mode: 'generate',
        modelAlias: 'image-model',
      },
    },
    {
      id: 'node_video',
      type: 'video',
      position: { x: 460, y: 100 },
      data: {
        label: 'Final video',
        mediaType: 'video',
        mode: 'generate',
        modelAlias: 'video-model',
      },
    },
  ],
  edges: [
    {
      id: 'edge_prompt_draft',
      sourceNodeId: 'node_prompt',
      sourceHandle: 'output:text',
      targetNodeId: 'node_draft',
      targetHandle: 'input:content',
      order: 0,
    },
    {
      id: 'edge_draft_image',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_image',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_style_image',
      sourceNodeId: 'node_style',
      sourceHandle: 'output:image',
      targetNodeId: 'node_image',
      targetHandle: 'input:style',
      order: 1,
    },
    {
      id: 'edge_draft_video',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_video',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_image_video',
      sourceNodeId: 'node_image',
      sourceHandle: 'output:image',
      targetNodeId: 'node_video',
      targetHandle: 'input:firstFrame',
      order: 1,
    },
  ],
  inputs: [
    {
      nodeId: 'node_draft',
      role: 'prompt',
      sortOrder: 0,
      snapshot: {
        id: 'node_draft',
        type: 'text',
        position: { x: 200, y: 0 },
        data: {
          label: 'Draft prompt',
          mediaType: 'text',
          mode: 'transform',
          modelAlias: 'text-model',
        },
      },
    },
    {
      nodeId: 'node_image',
      role: 'firstFrame',
      sortOrder: 1,
      snapshot: {
        id: 'node_image',
        type: 'image',
        position: { x: 220, y: 200 },
        data: {
          label: 'Key frame',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'image-model',
        },
      },
    },
  ],
};

function createJob(data: RunJobData): StubJob {
  const job: StubJob = {
    id: data.runId,
    data: data as unknown as Record<string, unknown>,
    async updateData(next) {
      this.data = next;
    },
    async updateProgress() {},
  };
  bullmqState.jobs.set(job.id, job);
  return job;
}

function createExecution(snapshot: RunSnapshot) {
  const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
  if (!target) throw new Error('missing test target');
  return {
    result: {
      provider: 'newapi',
      summary: `completed ${target.id}`,
      targetNodeId: target.id,
      mediaType: target.data.mediaType,
      inputCount: snapshot.inputs.length,
    },
    output:
      target.data.mediaType === 'text'
        ? {
            mediaType: 'text' as const,
            kind: 'text' as const,
            text: `output for ${target.id}`,
            mimeType: 'text/plain' as const,
            format: 'txt' as const,
          }
        : {
            mediaType: target.data.mediaType,
            kind: 'url' as const,
            url: `https://provider.example/${target.id}`,
            mimeType: target.data.mediaType === 'image' ? 'image/png' : 'video/mp4',
          },
  };
}

function createTextSnapshot(): RunSnapshot {
  return {
    projectId,
    canvasRevision: 8,
    targetNodeId: 'node_draft',
    modelAlias: 'text-model',
    credentialId,
    credentialVersion: 1,
    parameters: {},
    submittedAt: '2026-08-27T01:00:00.000Z',
    nodes: snapshot.nodes.filter((node) => ['node_prompt', 'node_draft'].includes(node.id)),
    edges: snapshot.edges.filter((edge) => edge.id === 'edge_prompt_draft'),
    inputs: [
      {
        nodeId: 'node_prompt',
        role: 'content',
        sortOrder: 0,
        sourceAssetId: 'asset_prompt',
        snapshot: snapshot.nodes.find((node) => node.id === 'node_prompt')!,
      },
    ],
  };
}

describe('worker workflow DAG execution', () => {
  it('hashes the same shared v2 fingerprint material as the API', () => {
    const expected = createHash('sha256')
      .update(runSnapshotFingerprintMaterial(snapshot))
      .digest('hex');

    expect(workflowSnapshotFingerprint(snapshot)).toBe(expected);
  });

  it('executes fan-in nodes in order and freezes archived results into downstream snapshots', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174101';
    const calls: RunSnapshot[] = [];
    const archiveTargets: string[] = [];
    const standardProvider = {
      execute: vi.fn(
        async (request: { snapshot: RunSnapshot; reportProgress?: (value: number) => unknown }) => {
          calls.push(request.snapshot);
          await request.reportProgress?.(100);
          return createExecution(request.snapshot);
        },
      ),
    };
    const videoProvider = {
      execute: vi.fn(
        async (request: { snapshot: RunSnapshot; reportProgress?: (value: number) => unknown }) => {
          calls.push(request.snapshot);
          await request.reportProgress?.(100);
          return createExecution(request.snapshot);
        },
      ),
    };
    const job = createJob({
      runId,
      snapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: standardProvider,
      videoProvider,
      stepDelayMs: 0,
      resultArchiver: async ({ snapshot: nodeSnapshot, result }) => {
        archiveTargets.push(nodeSnapshot.targetNodeId);
        return {
          assetId: `asset_${nodeSnapshot.targetNodeId}`,
          version: 1,
          contentUrl: `https://assets.example/${nodeSnapshot.targetNodeId}`,
          mimeType:
            result.mediaType === 'text'
              ? 'text/plain'
              : result.mediaType === 'image'
                ? 'image/png'
                : 'video/mp4',
        };
      },
    });

    const processed = await bullmqState.processor?.(job);

    expect(calls.map((call) => call.targetNodeId)).toEqual([
      'node_draft',
      'node_image',
      'node_video',
    ]);
    expect(archiveTargets).toEqual(['node_draft', 'node_image', 'node_video']);
    expect(calls[1]?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'node_draft',
          sourceAssetId: 'asset_node_draft',
        }),
        expect.objectContaining({ nodeId: 'node_style', sourceAssetId: 'asset_style' }),
      ]),
    );
    expect(calls[2]?.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'node_draft',
          sourceAssetId: 'asset_node_draft',
        }),
        expect.objectContaining({
          nodeId: 'node_image',
          sourceAssetId: 'asset_node_image',
        }),
      ]),
    );
    const state = job.data.workflowState as WorkflowState;
    expect(state.nodes.every((node) => node.status === 'succeeded')).toBe(true);
    expect(workflowNodeState(state, 'node_draft')?.providerJob?.id).toBe(
      `provider_job_${runId}_node_draft`,
    );
    expect(workflowNodeState(state, 'node_image')?.providerJob?.id).toBe(
      `provider_job_${runId}_node_image`,
    );
    expect(workflowNodeState(state, 'node_video')?.providerJob?.id).toBe(`provider_job_${runId}`);
    expect(processed).toMatchObject({
      status: 'succeeded',
      result: { targetNodeId: 'node_video', asset: { assetId: 'asset_node_video' } },
    });
  });

  it('keeps later DAG nodes on the submitted snapshot when a provider mutates job data', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174125';
    const submittedSnapshot = structuredClone(snapshot);
    const requests: RunSnapshot[] = [];
    const job = createJob({
      runId,
      snapshot: submittedSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    const provider = {
      execute: vi.fn(async (request: { snapshot: RunSnapshot }) => {
        requests.push(request.snapshot);
        const execution = createExecution(request.snapshot);
        if (request.snapshot.targetNodeId === 'node_draft') {
          const mutableSnapshot = job.data.snapshot as unknown as RunSnapshot;
          const imageNode = mutableSnapshot.nodes.find((node) => node.id === 'node_image');
          if (imageNode && imageNode.data.mode !== 'source') {
            imageNode.data.modelAlias = 'tampered-model';
          }
        }
        return execution;
      }),
    };

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      videoProvider: provider,
      stepDelayMs: 0,
      resultArchiver: async ({ result, snapshot: nodeSnapshot }) => ({
        assetId: `asset_${nodeSnapshot.targetNodeId}`,
        version: 1,
        contentUrl: `https://assets.example/${nodeSnapshot.targetNodeId}`,
        mimeType:
          result.mediaType === 'text'
            ? 'text/plain'
            : result.mediaType === 'image'
              ? 'image/png'
              : 'video/mp4',
      }),
    });

    await expect(bullmqState.processor?.(job)).resolves.toMatchObject({ status: 'succeeded' });
    expect(requests.map((request) => request.targetNodeId)).toEqual([
      'node_draft',
      'node_image',
      'node_video',
    ]);
    expect(requests[1]?.nodes.find((node) => node.id === 'node_image')?.data).toMatchObject({
      modelAlias: 'image-model',
    });
    expect((job.data.snapshot as unknown as RunSnapshot).nodes).toEqual(submittedSnapshot.nodes);
  });

  it('keeps a generated node loading without a result until its asset is archived', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174123';
    const textSnapshot = createTextSnapshot();
    let releaseArchive!: () => void;
    let archiveStarted!: () => void;
    const archiveReady = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    const archiveRelease = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const job = createJob({
      runId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: async (request) => createExecution(request.snapshot) },
      stepDelayMs: 0,
      resultArchiver: async () => {
        archiveStarted();
        await archiveRelease;
        return { assetId: 'asset_text_loading', version: 1, mimeType: 'text/plain' };
      },
    });

    const processing = bullmqState.processor?.(job);
    await archiveReady;
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')).toMatchObject({
      status: 'running',
      providerJob: { status: 'running' },
    });
    expect(
      workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')?.result,
    ).toBeUndefined();

    releaseArchive();
    await expect(processing).resolves.toMatchObject({
      status: 'succeeded',
      result: { asset: { assetId: 'asset_text_loading', version: 1 } },
    });
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')).toMatchObject({
      status: 'succeeded',
      result: { asset: { assetId: 'asset_text_loading', version: 1 } },
    });
  });

  it('marks the run failed when result archiving fails and never reports succeeded', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174124';
    const runStatuses: string[] = [];
    const job = createJob({
      runId,
      snapshot: createTextSnapshot(),
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: async (request) => createExecution(request.snapshot) },
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        async upsertProviderJob() {},
        async recordUsage() {},
        async updateRun(input) {
          runStatuses.push(input.status);
        },
      },
      resultArchiver: async () => {
        throw new Error('asset archive unavailable');
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('asset archive unavailable');
    expect(runStatuses).toContain('failed');
    expect(runStatuses).not.toContain('succeeded');
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')).toMatchObject({
      status: 'failed',
    });
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')?.result).toBe(
      undefined,
    );
  });

  it('stops downstream execution after an intermediate node fails', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174102';
    const targets: string[] = [];
    const videoProvider = { execute: vi.fn() };
    const job = createJob({
      runId,
      snapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          targets.push(request.snapshot.targetNodeId);
          if (request.snapshot.targetNodeId === 'node_image') {
            throw new Error('image generation failed');
          }
          return createExecution(request.snapshot);
        },
      },
      videoProvider,
      stepDelayMs: 0,
      resultArchiver: async ({ snapshot: nodeSnapshot }) => ({
        assetId: `asset_${nodeSnapshot.targetNodeId}`,
        version: 1,
        contentUrl: `https://assets.example/${nodeSnapshot.targetNodeId}`,
      }),
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('image generation failed');

    expect(targets).toEqual(['node_draft', 'node_image']);
    expect(videoProvider.execute).not.toHaveBeenCalled();
    const state = job.data.workflowState as WorkflowState;
    expect(workflowNodeState(state, 'node_draft')?.status).toBe('succeeded');
    expect(workflowNodeState(state, 'node_image')?.status).toBe('failed');
    expect(workflowNodeState(state, 'node_image')?.result).toBeUndefined();
    expect(workflowNodeState(state, 'node_video')?.status).toBe('pending');
    expect(job.data.providerJob).toMatchObject({ status: 'failed' });
  });

  it('reuses completed predecessor nodes and resumes its target platform task', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174103';
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174104';
    const predecessorProviderJob = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'running', 86),
      platformJobId: 'platform-video-existing',
      payload: { workflowNodeId: 'node_video', phase: 'polling' },
    };
    let predecessorState = createInitialWorkflowState(snapshot, predecessorProviderJob);
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_draft',
      status: 'succeeded',
      result: {
        provider: 'newapi',
        summary: 'draft completed',
        targetNodeId: 'node_draft',
        mediaType: 'text',
        inputCount: 1,
        asset: {
          assetId: 'asset_draft_existing',
          version: 1,
          contentUrl: 'https://assets.example/draft-existing',
          mimeType: 'text/plain',
        },
      },
    });
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_image',
      status: 'succeeded',
      result: {
        provider: 'newapi',
        summary: 'image completed',
        targetNodeId: 'node_image',
        mediaType: 'image',
        inputCount: 2,
        asset: {
          assetId: 'asset_image_existing',
          version: 1,
          contentUrl: 'https://assets.example/image-existing.png',
          mimeType: 'image/png',
        },
      },
    });
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_video',
      status: 'running',
      providerJob: predecessorProviderJob,
    });
    const predecessor = createJob({
      runId: predecessorRunId,
      snapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: predecessorProviderJob,
      workflowState: predecessorState,
      cancelRequested: false,
    });
    bullmqState.jobs.set(predecessorRunId, predecessor);
    const job = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const standardProvider = { execute: vi.fn() };
    const videoRequests: Array<{
      snapshot: RunSnapshot;
      providerJob?: { id?: string; platformJobId?: string };
    }> = [];
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: standardProvider,
      videoProvider: {
        async execute(request) {
          videoRequests.push(request);
          return createExecution(request.snapshot);
        },
      },
      stepDelayMs: 0,
      resultArchiver: async () => ({
        assetId: 'asset_video_resumed',
        version: 1,
        contentUrl: 'https://assets.example/video-resumed.mp4',
        mimeType: 'video/mp4',
      }),
    });

    await bullmqState.processor?.(job);

    expect(standardProvider.execute).not.toHaveBeenCalled();
    expect(videoRequests).toHaveLength(1);
    expect(videoRequests[0]).toMatchObject({
      providerJob: {
        id: `provider_job_${runId}`,
        platformJobId: 'platform-video-existing',
      },
      snapshot: {
        inputs: expect.arrayContaining([
          expect.objectContaining({ sourceAssetId: 'asset_draft_existing' }),
          expect.objectContaining({ sourceAssetId: 'asset_image_existing' }),
        ]),
      },
    });
    const state = job.data.workflowState as WorkflowState;
    expect(state.nodes.every((node) => node.status === 'succeeded')).toBe(true);
    expect(job.data.providerJob).toMatchObject({
      id: `provider_job_${runId}`,
      platformJobId: 'platform-video-existing',
      status: 'succeeded',
    });
  });

  it('reuses completed upstream work and request identity after intermediate cancellation', async () => {
    bullmqState.jobs.clear();
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174111';
    const runId = '123e4567-e89b-42d3-a456-426614174112';
    const usageRecords: Array<{ providerJobId?: string }> = [];
    const persistence = {
      getProviderCredentials: getTestProviderCredentials,
      async upsertProviderJob() {},
      async recordUsage(input: { providerJobId?: string }) {
        usageRecords.push(input);
      },
    };
    const predecessor = createJob({
      runId: predecessorRunId,
      snapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(predecessorRunId, 'newapi'),
      cancelRequested: false,
    });
    const firstAttemptRequests: Array<{ nodeId: string; providerJobId?: string }> = [];
    const firstVideoProvider = { execute: vi.fn() };

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          firstAttemptRequests.push({
            nodeId: request.snapshot.targetNodeId,
            providerJobId: request.providerJob?.id,
          });
          if (request.snapshot.targetNodeId === 'node_image') {
            predecessor.data.cancelRequested = true;
            return {
              ...createExecution(request.snapshot),
              usage: { amount: '2.50', currency: 'USD' },
            };
          }
          return createExecution(request.snapshot);
        },
      },
      videoProvider: firstVideoProvider,
      stepDelayMs: 0,
      persistence,
      resultArchiver: async ({ snapshot: nodeSnapshot }) => ({
        assetId: `asset_${nodeSnapshot.targetNodeId}_first`,
        version: 1,
        mimeType: nodeSnapshot.targetNodeId === 'node_draft' ? 'text/plain' : 'image/png',
      }),
    });

    await expect(bullmqState.processor?.(predecessor)).resolves.toMatchObject({
      status: 'cancelled',
    });
    expect(firstAttemptRequests.map((request) => request.nodeId)).toEqual([
      'node_draft',
      'node_image',
    ]);
    expect(firstVideoProvider.execute).not.toHaveBeenCalled();
    expect(usageRecords).toHaveLength(0);
    const predecessorState = predecessor.data.workflowState as WorkflowState;
    expect(workflowNodeState(predecessorState, 'node_draft')?.status).toBe('succeeded');
    expect(workflowNodeState(predecessorState, 'node_image')?.status).toBe('cancelled');

    const retry = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const retryRequests: Array<{ nodeId: string; providerJobId?: string }> = [];
    const videoProvider = {
      execute: vi.fn(async (request) => createExecution(request.snapshot)),
    };

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          retryRequests.push({
            nodeId: request.snapshot.targetNodeId,
            providerJobId: request.providerJob?.id,
          });
          return {
            ...createExecution(request.snapshot),
            usage: { amount: '2.50', currency: 'USD' },
          };
        },
      },
      videoProvider,
      stepDelayMs: 0,
      persistence,
      resultArchiver: async ({ snapshot: nodeSnapshot }) => ({
        assetId: `asset_${nodeSnapshot.targetNodeId}_retry`,
        version: 1,
        mimeType: nodeSnapshot.targetNodeId === 'node_image' ? 'image/png' : 'video/mp4',
      }),
    });

    await expect(bullmqState.processor?.(retry)).resolves.toMatchObject({ status: 'succeeded' });

    expect(retryRequests).toEqual([
      {
        nodeId: 'node_image',
        providerJobId: `provider_job_${predecessorRunId}_node_image`,
      },
    ]);
    expect(firstAttemptRequests[1]?.providerJobId).toBe(retryRequests[0]?.providerJobId);
    expect(videoProvider.execute).toHaveBeenCalledOnce();
    expect(usageRecords).toEqual([
      expect.objectContaining({
        providerJobId: `provider_job_${predecessorRunId}_node_image`,
      }),
    ]);
    expect(
      (retry.data.workflowState as WorkflowState).nodes.every(
        (nodeState) => nodeState.status === 'succeeded',
      ),
    ).toBe(true);
  });

  it('fails before a paid request when its pre-submit provider job cannot be persisted', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174105';
    const textSnapshot = createTextSnapshot();
    const provider = { execute: vi.fn(async (request) => createExecution(request.snapshot)) };
    const job = createJob({
      runId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      persistence: {
        async upsertProviderJob() {
          throw new Error('provider job database unavailable');
        },
        async recordUsage() {},
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('provider job database unavailable');
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it('replays a result already stored in workflow state after the final run write fails', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174106';
    const textSnapshot = createTextSnapshot();
    const provider = { execute: vi.fn(async (request) => createExecution(request.snapshot)) };
    let rejectSucceededWrite = true;
    const runStatuses: string[] = [];
    const job = createJob({
      runId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        async upsertProviderJob() {},
        async recordUsage() {},
        async updateRun(input) {
          runStatuses.push(input.status);
          if (input.status === 'succeeded' && rejectSucceededWrite) {
            rejectSucceededWrite = false;
            throw new Error('final run write unavailable');
          }
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_draft_replayed',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('final run write unavailable');
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')).toMatchObject({
      status: 'failed',
      result: { asset: { assetId: 'asset_draft_replayed' } },
    });
    expect(runStatuses).toContain('failed');

    await expect(bullmqState.processor?.(job)).resolves.toMatchObject({
      status: 'succeeded',
      result: { asset: { assetId: 'asset_draft_replayed' } },
    });
    expect(provider.execute).toHaveBeenCalledOnce();
  });

  it('uses the same archive identity when usage persistence forces a provider replay', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174119';
    const textSnapshot = createTextSnapshot();
    const providerJobIds: Array<string | undefined> = [];
    const archiveKeys: Array<string | undefined> = [];
    let rejectUsage = true;
    const job = createJob({
      runId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          providerJobIds.push(request.providerJob?.id);
          return {
            ...createExecution(request.snapshot),
            usage: { amount: '1.00', currency: 'USD' },
          };
        },
      },
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        async upsertProviderJob() {},
        async recordUsage() {
          if (rejectUsage) {
            rejectUsage = false;
            throw new Error('usage database unavailable');
          }
        },
      },
      onPersistenceError(error) {
        throw error;
      },
      resultArchiver: async (input) => {
        archiveKeys.push(input.archiveKey);
        return { assetId: 'asset_usage_replay', version: 1, mimeType: 'text/plain' };
      },
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('usage database unavailable');
    await expect(bullmqState.processor?.(job)).resolves.toMatchObject({ status: 'succeeded' });

    expect(providerJobIds).toEqual([`provider_job_${runId}`, `provider_job_${runId}`]);
    expect(archiveKeys).toHaveLength(2);
    expect(archiveKeys[0]).toBe(archiveKeys[1]);
  });

  it('keeps the original synchronous request identity and usage key across a retry', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174107';
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174108';
    const textSnapshot = createTextSnapshot();
    const predecessorProviderJob = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'failed', 80),
      payload: { workflowNodeId: 'node_draft', error: 'ambiguous provider response' },
    };
    let predecessorState = createInitialWorkflowState(textSnapshot, predecessorProviderJob);
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_draft',
      status: 'failed',
      providerJob: predecessorProviderJob,
    });
    createJob({
      runId: predecessorRunId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: predecessorProviderJob,
      workflowState: predecessorState,
      cancelRequested: false,
    });
    const job = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot: textSnapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const requestProviderJobIds: Array<string | undefined> = [];
    const usageRecords: Array<{ providerJobId?: string }> = [];

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          requestProviderJobIds.push(request.providerJob?.id);
          return {
            ...createExecution(request.snapshot),
            usage: { amount: '1.25', currency: 'USD' },
          };
        },
      },
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        async upsertProviderJob() {},
        async recordUsage(input) {
          usageRecords.push(input);
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_draft_retry',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await bullmqState.processor?.(job);

    expect(requestProviderJobIds).toEqual([`provider_job_${predecessorRunId}`]);
    expect(usageRecords).toEqual([
      expect.objectContaining({ providerJobId: `provider_job_${predecessorRunId}` }),
    ]);
    expect(job.data.providerJob).toMatchObject({
      id: `provider_job_${runId}`,
      status: 'succeeded',
    });
  });

  it('recovers completed upstream results and a live target task from persistence only', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174109';
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174110';
    const job = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const standardProvider = { execute: vi.fn() };
    const videoRequests: Array<{
      snapshot: RunSnapshot;
      providerJob?: { platformJobId?: string };
    }> = [];
    const persistedResult = (
      nodeId: string,
      mediaType: 'text' | 'image',
      assetId: string,
      inputCount: number,
    ) => ({
      provider: 'newapi',
      summary: `${nodeId} persisted`,
      targetNodeId: nodeId,
      mediaType,
      inputCount,
      asset: {
        assetId,
        version: 1,
        mimeType: mediaType === 'text' ? 'text/plain' : 'image/png',
      },
    });
    const findProviderJobsByRunId = vi.fn(async () => [
      {
        ...createProviderJobRecord(predecessorRunId, 'newapi', 'succeeded', 100),
        payload: {
          workflowNodeId: 'node_draft',
          snapshotFingerprint: workflowSnapshotFingerprint(snapshot),
          result: persistedResult('node_draft', 'text', 'asset_draft_database', 1),
        },
      },
      {
        ...createProviderJobRecord(predecessorRunId, 'newapi', 'succeeded', 100),
        payload: {
          workflowNodeId: 'node_image',
          snapshotFingerprint: workflowSnapshotFingerprint(snapshot),
          result: persistedResult('node_image', 'image', 'asset_image_database', 2),
        },
      },
      {
        ...createProviderJobRecord(predecessorRunId, 'newapi', 'failed', 88),
        platformJobId: 'platform-video-database',
        payload: {
          workflowNodeId: 'node_video',
          snapshotFingerprint: workflowSnapshotFingerprint(snapshot),
          phase: 'polling',
        },
      },
    ]);

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: standardProvider,
      videoProvider: {
        async execute(request) {
          videoRequests.push(request);
          await request.onProviderJob?.({
            provider: 'newapi',
            platformJobId: 'platform-video-database',
            status: 'running',
            payload: {
              phase: 'polling',
              requestProviderJobId: 'provider-controlled-value-must-not-win',
            },
          });
          return createExecution(request.snapshot);
        },
      },
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        findProviderJobsByRunId,
        async upsertProviderJob() {},
        async recordUsage() {},
      },
      resultArchiver: async () => ({
        assetId: 'asset_video_database',
        version: 1,
        mimeType: 'video/mp4',
      }),
    });

    await bullmqState.processor?.(job);

    expect(findProviderJobsByRunId).toHaveBeenCalledWith(predecessorRunId);
    expect(standardProvider.execute).not.toHaveBeenCalled();
    expect(videoRequests).toHaveLength(1);
    expect(videoRequests[0]).toMatchObject({
      providerJob: { platformJobId: 'platform-video-database' },
      snapshot: {
        inputs: expect.arrayContaining([
          expect.objectContaining({ sourceAssetId: 'asset_draft_database' }),
          expect.objectContaining({ sourceAssetId: 'asset_image_database' }),
        ]),
      },
    });
    expect(job.data.providerJob).toMatchObject({
      status: 'succeeded',
      payload: {
        requestProviderJobId: `provider_job_${predecessorRunId}`,
        workflowNodeId: 'node_video',
      },
    });
  });

  it('does not recover completed work from a different immutable snapshot', async () => {
    bullmqState.jobs.clear();
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174113';
    const runId = '123e4567-e89b-42d3-a456-426614174114';
    const original = createTextSnapshot();
    const changed = { ...original, parameters: { temperature: 0.9 } };
    const predecessorProviderJob = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'succeeded', 100),
      payload: {
        workflowNodeId: 'node_draft',
        snapshotFingerprint: workflowSnapshotFingerprint(original),
      },
    };
    let predecessorState = createInitialWorkflowState(original, predecessorProviderJob);
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_draft',
      status: 'succeeded',
      providerJob: predecessorProviderJob,
      result: {
        provider: 'newapi',
        summary: 'old snapshot result',
        targetNodeId: 'node_draft',
        mediaType: 'text',
        inputCount: 1,
        asset: { assetId: 'asset_old_snapshot', version: 1, mimeType: 'text/plain' },
      },
    });
    createJob({
      runId: predecessorRunId,
      snapshot: original,
      attempt: 1,
      provider: 'newapi',
      providerJob: predecessorProviderJob,
      workflowState: predecessorState,
      cancelRequested: false,
    });
    const retry = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot: changed,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const requestIds: Array<string | undefined> = [];

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          requestIds.push(request.providerJob?.id);
          return createExecution(request.snapshot);
        },
      },
      stepDelayMs: 0,
      resultArchiver: async () => ({
        assetId: 'asset_changed_snapshot',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await bullmqState.processor?.(retry);

    expect(requestIds).toEqual([`provider_job_${runId}`]);
    expect(
      workflowNodeState(retry.data.workflowState as WorkflowState, 'node_draft'),
    ).toMatchObject({
      status: 'succeeded',
      result: { asset: { assetId: 'asset_changed_snapshot' } },
    });
  });

  it('recovers a persisted provider task written with the legacy v1 fingerprint', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174123';
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174124';
    const textSnapshot = createTextSnapshot();
    const persistedProviderJob = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'failed', 80),
      platformJobId: 'platform-v1-persisted',
      payload: {
        workflowNodeId: 'node_draft',
        phase: 'polling',
        snapshotFingerprint: workflowSnapshotFingerprintV1(textSnapshot),
      },
    };
    const retry = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot: textSnapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const provider = {
      execute: vi.fn(async (request) => {
        expect(request.providerJob).toMatchObject({ platformJobId: 'platform-v1-persisted' });
        return createExecution(request.snapshot);
      }),
    };
    const findProviderJobsByRunId = vi.fn(async () => [persistedProviderJob]);

    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      persistence: {
        getProviderCredentials: getTestProviderCredentials,
        findProviderJobsByRunId,
        async upsertProviderJob() {},
        async recordUsage() {},
      },
      resultArchiver: async () => ({
        assetId: 'asset_v1_recovered',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await expect(bullmqState.processor?.(retry)).resolves.toMatchObject({
      status: 'succeeded',
      providerJob: { platformJobId: 'platform-v1-persisted' },
    });
    expect(findProviderJobsByRunId).toHaveBeenCalledWith(predecessorRunId);
    expect(provider.execute).toHaveBeenCalledOnce();
  });

  it('does not reuse a legacy succeeded result without a frozen asset version', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174121';
    const predecessorRunId = '123e4567-e89b-42d3-a456-426614174122';
    const textSnapshot = createTextSnapshot();
    const predecessorProviderJob = {
      ...createProviderJobRecord(predecessorRunId, 'newapi', 'succeeded', 100),
      payload: {
        workflowNodeId: 'node_draft',
        snapshotFingerprint: workflowSnapshotFingerprint(textSnapshot),
      },
    };
    let predecessorState = createInitialWorkflowState(textSnapshot, predecessorProviderJob);
    predecessorState = replaceWorkflowNodeState(predecessorState, {
      nodeId: 'node_draft',
      status: 'succeeded',
      providerJob: predecessorProviderJob,
      result: {
        provider: 'newapi',
        summary: 'legacy unversioned result',
        targetNodeId: 'node_draft',
        mediaType: 'text',
        inputCount: 1,
        asset: { assetId: 'asset_legacy', mimeType: 'text/plain' },
      },
    });
    createJob({
      runId: predecessorRunId,
      snapshot: textSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: predecessorProviderJob,
      workflowState: predecessorState,
      cancelRequested: false,
    });
    const retry = createJob({
      runId,
      retryOf: predecessorRunId,
      snapshot: textSnapshot,
      attempt: 2,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const provider = { execute: vi.fn(async (request) => createExecution(request.snapshot)) };
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      stepDelayMs: 0,
      resultArchiver: async () => ({
        assetId: 'asset_rearchived',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await expect(bullmqState.processor?.(retry)).resolves.toMatchObject({
      status: 'succeeded',
      result: { asset: { assetId: 'asset_rearchived', version: 1 } },
    });
    expect(provider.execute).toHaveBeenCalledOnce();
  });

  it('persists a frozen intermediate model error without calling a provider', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174120';
    const invalidSnapshot = structuredClone(snapshot);
    const intermediate = invalidSnapshot.nodes.find((node) => node.id === 'node_draft');
    if (!intermediate) throw new Error('missing test intermediate node');
    delete intermediate.data.modelAlias;
    const job = createJob({
      runId,
      snapshot: invalidSnapshot,
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const provider = { execute: vi.fn() };
    const videoProvider = { execute: vi.fn() };
    const runUpdates: Array<{ status: string; error?: string }> = [];
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider,
      videoProvider,
      stepDelayMs: 0,
      resolveDatabaseRunId: () => runId,
      persistence: {
        async upsertProviderJob() {},
        async recordUsage() {},
        async updateRun(input) {
          runUpdates.push({ status: input.status, ...(input.error ? { error: input.error } : {}) });
        },
      },
      resultArchiver: async () => ({
        assetId: 'asset_should_not_exist',
        version: 1,
        mimeType: 'text/plain',
      }),
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow(
      'workflow node node_draft is missing a frozen model alias',
    );
    expect(provider.execute).not.toHaveBeenCalled();
    expect(videoProvider.execute).not.toHaveBeenCalled();
    expect(runUpdates.at(-1)).toEqual({
      status: 'failed',
      error: 'workflow node node_draft is missing a frozen model alias',
    });
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')?.status).toBe(
      'failed',
    );
  });

  it('fails closed when a provider returns no archivable output', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174115';
    const job = createJob({
      runId,
      snapshot: createTextSnapshot(),
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    const resultArchiver = vi.fn();
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          return createExecution(request.snapshot).result;
        },
      },
      stepDelayMs: 0,
      resultArchiver,
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow(
      'provider returned no archivable output',
    );
    expect(resultArchiver).not.toHaveBeenCalled();
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')?.status).toBe(
      'failed',
    );
  });

  it('fails closed when provider output has no configured archiver', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174116';
    const job = createJob({
      runId,
      snapshot: createTextSnapshot(),
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: async (request) => createExecution(request.snapshot) },
      stepDelayMs: 0,
    });

    await expect(bullmqState.processor?.(job)).rejects.toThrow('result archiver is required');
  });

  it('cooperatively aborts a provider wait when cancellation is requested', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174117';
    const job = createJob({
      runId,
      snapshot: createTextSnapshot(),
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    let providerSignal: AbortSignal | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const resultArchiver = vi.fn();
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: {
        async execute(request) {
          providerSignal = request.signal;
          providerStarted?.();
          return new Promise((_resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          });
        },
      },
      stepDelayMs: 0,
      cancellationPollMs: 1,
      resultArchiver,
    });

    const processing = bullmqState.processor?.(job);
    await started;
    job.data.cancelRequested = true;

    await expect(processing).resolves.toMatchObject({ status: 'cancelled' });
    expect(providerSignal?.aborted).toBe(true);
    expect(resultArchiver).not.toHaveBeenCalled();
  });

  it('cooperatively aborts result archiving when cancellation is requested', async () => {
    bullmqState.jobs.clear();
    const runId = '123e4567-e89b-42d3-a456-426614174118';
    const job = createJob({
      runId,
      snapshot: createTextSnapshot(),
      attempt: 1,
      provider: 'newapi',
      providerJob: createProviderJobRecord(runId, 'newapi'),
      cancelRequested: false,
    });
    let archiveSignal: AbortSignal | undefined;
    let archiveStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    createRunWorker({
      connection: { host: '127.0.0.1', port: 6379 },
      providerName: 'newapi',
      provider: { execute: async (request) => createExecution(request.snapshot) },
      stepDelayMs: 0,
      cancellationPollMs: 1,
      resultArchiver: async (input) => {
        archiveSignal = input.signal;
        archiveStarted?.();
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        });
      },
    });

    const processing = bullmqState.processor?.(job);
    await started;
    job.data.cancelRequested = true;

    await expect(processing).resolves.toMatchObject({ status: 'cancelled' });
    expect(archiveSignal?.aborted).toBe(true);
    expect(workflowNodeState(job.data.workflowState as WorkflowState, 'node_draft')?.result).toBe(
      undefined,
    );
  });
});

import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore } from './assets';
import { withConnectedVideoResults } from './connected-video-results';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';

/** 本组仅使用内存存储和合成 HTTP 回执，不连接供应商。 */
const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', '');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 等待合成执行终态；超过期限保留明确失败，不重发请求。 */
async function completedRun(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('视频引用测试未在期限内结束');
}

/** 视频生成节点已有成功结果但持久画布没有 resultAsset 的真实数据形态。 */
function connectedVideoCanvas(
  targetMediaType: 'text' | 'video' = 'text',
  handle = 'input:content',
): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'video-source',
        type: 'video',
        position: { x: 0, y: 0 },
        data: {
          label: '已有视频',
          mediaType: 'video',
          mode: 'generate',
          modelAlias: 'seedance-video-test',
          prompt: '生成一段雨夜街景',
          stale: true,
        },
      },
      {
        id: 'consumer-target',
        type: targetMediaType,
        position: { x: 400, y: 0 },
        data: {
          label: '点评视频',
          mediaType: targetMediaType,
          mode: 'generate',
          modelAlias: targetMediaType === 'text' ? 'text-multimodal-test' : 'seedance-video-test',
          prompt: '点评这个视频',
        },
      },
    ],
    edges: [
      {
        id: 'video-consumer',
        sourceNodeId: 'video-source',
        sourceHandle: 'output:video',
        targetNodeId: 'consumer-target',
        targetHandle: handle,
        order: 0,
      },
    ],
  };
}

/** 提供文字目标凭据、合成视频回执与可修改的归档历史。 */
async function fixture(handle = 'input:content') {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: '连线视频冻结' });
  const videoBytes = Buffer.from('displayed-video-version-one');
  const asset = await assetStore.create({
    projectId: project.id,
    name: 'generated.mp4',
    mediaType: 'video',
    mimeType: 'video/mp4',
    content: videoBytes,
  });
  const laterBytes = Buffer.from('later-video-version-two');
  await assetStore.createVersion(asset.id, { content: laterBytes });
  const settingsStore = new MemoryAiSettingsStore('connected-video-test');
  settingsStore.update({
    baseUrl: 'https://provider.example.test/v1',
    apiKey: 'synthetic-connected-video-key',
  });
  const credentialId = settingsStore.listCredentials()[0]!.id;
  settingsStore.replaceModels(
    [
      {
        id: 'text-multimodal-test',
        name: 'Text',
        mediaTypes: ['text'],
        refreshedAt: new Date().toISOString(),
      },
    ],
    credentialId,
  );
  const canvas = connectedVideoCanvas('text', handle);
  canvas.nodes[1]!.data.credentialId = credentialId;
  await projectStore.updateCanvas(project.id, canvas);
  const saved = (await projectStore.getCanvas(project.id))!;
  const videoCanvas: CanvasDocument = { revision: 0, nodes: [canvas.nodes[0]!], edges: [] };
  const history: RunRecord[] = [
    {
      id: 'previous-video-run',
      projectId: project.id,
      targetNodeId: 'video-source',
      status: 'succeeded',
      progress: 100,
      attempt: 1,
      provider: 'newapi',
      modelAlias: 'seedance-video-test',
      snapshot: createRunSnapshot(project.id, videoCanvas, 'video-source'),
      result: {
        provider: 'newapi',
        summary: 'Generated video',
        targetNodeId: 'video-source',
        mediaType: 'video',
        inputCount: 0,
        asset: { assetId: asset.id, version: 1, mimeType: 'video/mp4' },
      },
      createdAt: '2026-10-24T15:16:52.000Z',
      updatedAt: '2026-10-24T15:56:32.000Z',
    },
  ];
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ choices: [{ message: { content: 'ACCEPTANCE_OK' } }] }));
  const executor = createNewApiRunExecutor({
    settingsStore,
    providerFactory: {
      createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
      createVideo: (options) => new NewApiVideoProvider({ ...options, fetchImpl }),
    },
  });
  const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 1 });
  vi.spyOn(runService, 'listByProject').mockImplementation(async () => structuredClone(history));
  const app = buildApp({
    logger: false,
    assetStore,
    projectStore,
    settingsStore,
    runService,
    runExecutor: executor,
  });
  apps.push(app);
  return {
    app,
    asset,
    assetStore,
    project,
    projectStore,
    saved,
    history,
    runService,
    fetchImpl,
    videoBytes,
    laterBytes,
  };
}

describe('连线已有生成视频的运行边界', () => {
  it('input:content 只请求一次文字模型，不重跑视频节点', async () => {
    const context = await fixture();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/nodes/consumer-target/runs',
      payload: { projectId: context.project.id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await completedRun(context.runService, response.json().run.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(run.snapshot.nodes.map((node) => node.id)).toEqual(['video-source', 'consumer-target']);
    expect(run.snapshot.nodes[0]!.data).toMatchObject({
      mode: 'source',
      assetId: context.asset.id,
      mediaType: 'video',
    });
    expect(run.snapshot.nodes[0]!.data.modelAlias).toBeUndefined();
    expect(run.snapshot.inputs[0]).toMatchObject({
      nodeId: 'video-source',
      role: 'content',
      sourceAssetId: context.asset.id,
      sourceAssetVersion: 1,
    });
    expect(context.fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = context.fetchImpl.mock.calls[0];
    expect(url).toBe('https://provider.example.test/v1/chat/completions');
    const body = JSON.parse(request!.body as string);
    expect(body.model).toBe('text-multimodal-test');
    const messages = JSON.stringify(body.messages);
    expect(messages).toContain('点评这个视频');
    expect(messages).toContain(context.videoBytes.toString('base64'));
    expect(messages).not.toContain(context.laterBytes.toString('base64'));
    expect(messages).not.toContain('雨夜街景');
    expect(await context.projectStore.getCanvas(context.project.id)).toEqual(context.saved);
  });

  it.each(['archived', 'missing-result-version', 'foreign-project'] as const)(
    '%s 在创建运行前拒绝，不能退回重新生成视频',
    async (condition) => {
      const context = await fixture();
      if (condition === 'archived') await context.assetStore.setArchived(context.asset.id, true);
      if (condition === 'missing-result-version') delete context.history[0]!.result!.asset!.version;
      if (condition === 'foreign-project') {
        const otherProject = await context.projectStore.create({ name: '其他项目' });
        const foreign = await context.assetStore.create({
          projectId: otherProject.id,
          name: 'other.mp4',
          mediaType: 'video',
          mimeType: 'video/mp4',
          content: Buffer.from('private-other-video'),
        });
        context.history[0]!.result!.asset!.assetId = foreign.id;
      }
      const createRun = vi.spyOn(context.runService, 'create');
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/consumer-target/runs',
        payload: { projectId: context.project.id },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(createRun).not.toHaveBeenCalled();
      expect(context.fetchImpl).not.toHaveBeenCalled();
      expect(await context.projectStore.getCanvas(context.project.id)).toEqual(context.saved);
    },
  );

  it('较晚失败或另一个项目的成功记录不能替换正在引用的视频', async () => {
    const context = await fixture();
    context.history.push(
      {
        ...structuredClone(context.history[0]!),
        id: 'failed-run',
        status: 'failed',
        createdAt: '2026-10-25T00:00:00.000Z',
        result: undefined,
      },
      {
        ...structuredClone(context.history[0]!),
        id: 'foreign-run',
        projectId: 'another-project',
        createdAt: '2026-10-25T01:00:00.000Z',
        result: {
          ...context.history[0]!.result!,
          asset: { assetId: 'foreign-video', version: 2 },
        },
      },
    );
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/nodes/consumer-target/runs',
      payload: { projectId: context.project.id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await completedRun(context.runService, response.json().run.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(run.snapshot.inputs[0]).toMatchObject({
      sourceAssetId: context.asset.id,
      sourceAssetVersion: 1,
    });
  });
});

describe('视频回显执行投影的范围', () => {
  it('文字与视频目标都把已有视频截断为来源，且不改画布', async () => {
    for (const targetMediaType of ['text', 'video'] as const) {
      const canvas = connectedVideoCanvas(targetMediaType);
      const before = structuredClone(canvas);
      const context = await fixture();
      const projected = await withConnectedVideoResults({
        projectId: context.project.id,
        canvas,
        targetNodeId: 'consumer-target',
        runService: context.runService,
      });
      const snapshot = createRunSnapshot(context.project.id, projected.canvas, 'consumer-target');
      expect(snapshot.nodes.map((node) => node.id)).toEqual(['video-source', 'consumer-target']);
      expect(snapshot.nodes[0]!.data).toMatchObject({
        mode: 'source',
        assetId: context.asset.id,
      });
      expect(projected.sourceVersions).toEqual({ 'video-source': 1 });
      expect(canvas).toEqual(before);
    }
  });

  it('没有成功视频结果时保留原 DAG 语义', async () => {
    const canvas = connectedVideoCanvas();
    const projected = await withConnectedVideoResults({
      projectId: 'project',
      canvas,
      targetNodeId: 'consumer-target',
      runService: { listByProject: async () => [] },
    });
    expect(projected.canvas).toBe(canvas);
    expect(projected.sourceVersions).toEqual({});
  });

  it('缺少冻结版本时拒绝，不静默改用最新版本', async () => {
    const canvas = connectedVideoCanvas();
    const history: RunRecord[] = [
      {
        id: 'previous-video-run',
        projectId: 'project',
        targetNodeId: 'video-source',
        status: 'succeeded',
        progress: 100,
        attempt: 1,
        provider: 'newapi',
        modelAlias: 'seedance-video-test',
        snapshot: createRunSnapshot('project', canvas, 'video-source'),
        result: {
          provider: 'newapi',
          summary: 'Generated video',
          targetNodeId: 'video-source',
          mediaType: 'video',
          inputCount: 0,
          asset: { assetId: 'video-asset' },
        },
        createdAt: '2026-10-24T15:16:52.000Z',
        updatedAt: '2026-10-24T15:56:32.000Z',
      },
    ];
    await expect(
      withConnectedVideoResults({
        projectId: 'project',
        canvas,
        targetNodeId: 'consumer-target',
        runService: { listByProject: async () => history },
      }),
    ).rejects.toThrow('视频结果缺少冻结版本');
  });

  it.each([
    ['image-target', 'target-media'],
    ['referenceImage', 'handle'],
    ['disabled', 'source-disabled'],
    ['manual', 'source-manual'],
    ['target', 'explicit-target'],
    ['unrelated', 'no-edge'],
    ['text-result', 'result-media'],
  ] as const)('%s 不投影', async (_case, condition) => {
    const canvas = connectedVideoCanvas();
    const context = await fixture();
    if (condition === 'target-media') {
      canvas.nodes[1]!.type = 'image';
      canvas.nodes[1]!.data.mediaType = 'image';
    }
    if (condition === 'handle') canvas.edges[0]!.targetHandle = 'input:referenceImage';
    if (condition === 'source-disabled') canvas.nodes[0]!.data.enabled = false;
    if (condition === 'source-manual') canvas.nodes[0]!.data.manualOutput = true;
    if (condition === 'no-edge') canvas.edges = [];
    if (condition === 'result-media')
      context.history[0]!.result = {
        ...context.history[0]!.result!,
        mediaType: 'text',
        asset: { assetId: context.asset.id, version: 1 },
      };
    const projected = await withConnectedVideoResults({
      projectId: context.project.id,
      canvas,
      targetNodeId: condition === 'explicit-target' ? 'video-source' : 'consumer-target',
      runService: context.runService,
    });
    expect(projected.canvas).toBe(canvas);
    expect(projected.sourceVersions).toEqual({});
  });

  it('来源是图片生成节点时由图片投影处理，不在此处冻结', async () => {
    const canvas = connectedVideoCanvas();
    canvas.nodes[0]!.type = 'image';
    canvas.nodes[0]!.data.mediaType = 'image';
    const context = await fixture();
    const projected = await withConnectedVideoResults({
      projectId: context.project.id,
      canvas,
      targetNodeId: 'consumer-target',
      runService: context.runService,
    });
    expect(projected.canvas).toBe(canvas);
  });
});

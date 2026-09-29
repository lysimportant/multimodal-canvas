import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore } from './assets';
import { withConnectedImageResults } from './connected-image-results';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { MemoryProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';

/** 本组仅使用内存存储和合成 HTTP 回执，不连接供应商。 */
const apps: Array<ReturnType<typeof buildApp>> = [];

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('WORKER_PROVIDER', 'mock');
  vi.stubEnv('API_AUTH_TOKEN', '');
  vi.stubEnv('API_JWT_SECRET', '');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 等待合成执行终态；超过一秒保留明确失败，不发送补偿请求。 */
async function completedRun(service: MemoryRunService, id: string): Promise<RunRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('图片引用测试未在期限内结束');
}

/** 构造已有图片回显但持久画布没有 resultAsset 的真实数据形态。 */
async function referenceFixture(handle = 'input:content') {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: '连线图片冻结' });
  const imageBytes = Buffer.from('displayed-image-version-one');
  const asset = await assetStore.create({
    projectId: project.id,
    name: 'generated.png',
    mediaType: 'image',
    mimeType: 'image/png',
    content: imageBytes,
  });
  await assetStore.createVersion(asset.id, { content: Buffer.from('later-image-version-two') });
  const settingsStore = new MemoryAiSettingsStore('connected-image-test');
  settingsStore.update({
    baseUrl: 'https://provider.example.test/v1',
    apiKey: 'synthetic-connected-image-key',
  });
  const credentialId = settingsStore.listCredentials()[0]!.id;
  settingsStore.replaceModels(
    [
      {
        id: 'gpt-image-2.5-sunburst',
        name: 'Image',
        mediaTypes: ['image'],
        refreshedAt: new Date().toISOString(),
      },
    ],
    credentialId,
  );
  const canvas: CanvasDocument = {
    revision: 0,
    nodes: [
      {
        id: 'text-ancestor',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: '无关的文字祖先',
          mediaType: 'text',
          mode: 'generate',
          modelAlias: 'gpt-image-2',
          credentialId,
        },
      },
      {
        id: 'image-source',
        type: 'image',
        position: { x: 300, y: 0 },
        data: {
          label: '已有图片',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'gpt-image-2.5-sunburst',
          credentialId,
          stale: true,
        },
      },
      {
        id: 'image-target',
        type: 'image',
        position: { x: 600, y: 0 },
        data: {
          label: '图生图',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'gpt-image-2.5-sunburst',
          credentialId,
          prompt: 'Create a desktop wallpaper from the supplied character image.',
        },
      },
    ],
    edges: [
      {
        id: 'text-image',
        sourceNodeId: 'text-ancestor',
        sourceHandle: 'output:text',
        targetNodeId: 'image-source',
        targetHandle: 'input:content',
        order: 0,
      },
      {
        id: 'image-image',
        sourceNodeId: 'image-source',
        sourceHandle: 'output:image',
        targetNodeId: 'image-target',
        targetHandle: handle,
        order: 0,
      },
    ],
  };
  await projectStore.updateCanvas(project.id, canvas);
  const saved = (await projectStore.getCanvas(project.id))!;
  const sourceCanvas = { revision: 0, nodes: [canvas.nodes[1]], edges: [] };
  const history: RunRecord[] = [
    {
      id: 'previous-image-run',
      projectId: project.id,
      targetNodeId: 'image-source',
      status: 'succeeded',
      progress: 100,
      attempt: 1,
      provider: 'newapi',
      modelAlias: 'gpt-image-2.5-sunburst',
      snapshot: createRunSnapshot(project.id, sourceCanvas, 'image-source'),
      result: {
        provider: 'newapi',
        summary: 'Generated image',
        targetNodeId: 'image-source',
        mediaType: 'image',
        inputCount: 0,
        asset: { assetId: asset.id, version: 1, mimeType: 'image/png' },
      },
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:01:00.000Z',
    },
  ];
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ data: [{ b64_json: Buffer.from('synthetic-output').toString('base64') }] }),
    );
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
    imageBytes,
  };
}

describe('连线已有生成图片的运行边界', () => {
  it.each(['input:content', 'input:referenceImage', 'input:imageEdit'])(
    '%s 只发送一次图片编辑请求，不执行文字祖先或覆盖源节点',
    async (handle) => {
      const fixture = await referenceFixture(handle);
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/v1/nodes/image-target/runs',
        payload: { projectId: fixture.project.id },
      });
      expect(response.statusCode, response.body).toBe(202);
      const run = await completedRun(fixture.runService, response.json().run.id);
      expect(run.status, run.error).toBe('succeeded');
      expect(run.snapshot.nodes.map((node) => node.id)).toEqual(['image-source', 'image-target']);
      expect(run.snapshot.nodes[0].data.mode).toBe('source');
      expect(run.snapshot.inputs[0]).toMatchObject({
        sourceAssetId: fixture.asset.id,
        sourceAssetVersion: 1,
      });
      expect(fixture.fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fixture.fetchImpl.mock.calls[0];
      expect(url).toBe('https://provider.example.test/v1/images/edits');
      const form = request!.body as FormData;
      expect(form.get('model')).toBe('gpt-image-2.5-sunburst');
      expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(
        fixture.imageBytes,
      );
      expect(await fixture.projectStore.getCanvas(fixture.project.id)).toEqual(fixture.saved);
    },
  );
});

/** 未发送条件和历史结果选择必须在排队前确定，不能依赖真实 Provider 拒绝。 */
describe('连线图片版本与授权回归', () => {
  it.each(['archived', 'missing-version', 'foreign-project', 'missing-result-version'])(
    '%s 在创建运行前拒绝，不能退回重新生成原图',
    async (condition) => {
      const fixture = await referenceFixture();
      if (condition === 'archived') await fixture.assetStore.setArchived(fixture.asset.id, true);
      if (condition === 'missing-version') fixture.history[0].result!.asset!.version = 30;
      if (condition === 'missing-result-version') delete fixture.history[0].result!.asset!.version;
      if (condition === 'foreign-project') {
        const otherProject = await fixture.projectStore.create({ name: '其他项目' });
        const otherAsset = await fixture.assetStore.create({
          projectId: otherProject.id,
          name: 'other.png',
          mediaType: 'image',
          mimeType: 'image/png',
          content: Buffer.from('private-other-image'),
        });
        fixture.history[0].result!.asset!.assetId = otherAsset.id;
      }
      const createRun = vi.spyOn(fixture.runService, 'create');
      const response = await fixture.app.inject({
        method: 'POST',
        url: '/v1/nodes/image-target/runs',
        payload: { projectId: fixture.project.id },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(createRun).not.toHaveBeenCalled();
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
      expect(await fixture.projectStore.getCanvas(fixture.project.id)).toEqual(fixture.saved);
    },
  );

  it('显式图生图仍使用旧原图版本，不跟随来源后续结果', async () => {
    const fixture = await referenceFixture('input:imageEdit');
    fixture.history.push({
      ...structuredClone(fixture.history[0]),
      id: 'newer-image-run',
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:01:00.000Z',
      result: {
        ...fixture.history[0].result!,
        asset: { assetId: fixture.asset.id, version: 2, mimeType: 'image/png' },
      },
    });
    const canvas = structuredClone(fixture.saved);
    canvas.nodes[2].data.imageEditSource = {
      sourceNodeId: 'image-source',
      assetId: fixture.asset.id,
      version: 1,
      sourceKind: 'result',
    };
    await fixture.projectStore.updateCanvas(fixture.project.id, canvas);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      payload: { projectId: fixture.project.id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await completedRun(fixture.runService, response.json().run.id);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.snapshot.inputs[0].sourceAssetVersion).toBe(1);
    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    const form = fixture.fetchImpl.mock.calls[0][1]!.body as FormData;
    expect(Buffer.from(await (form.get('image') as File).arrayBuffer())).toEqual(
      fixture.imageBytes,
    );
  });

  it('上游没有成功图片时保留原工作流，不伪造来源或忽略错误模型', async () => {
    const fixture = await referenceFixture();
    fixture.history.length = 0;
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      payload: { projectId: fixture.project.id },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'model_unavailable' });
    expect(response.json().error).toContain('text-ancestor');
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it('较晚失败或另一个项目的成功记录不能替换正在引用的图片', async () => {
    const fixture = await referenceFixture();
    fixture.history.push(
      {
        ...structuredClone(fixture.history[0]),
        id: 'failed-run',
        status: 'failed',
        createdAt: '2026-09-29T00:00:00.000Z',
        result: undefined,
      },
      {
        ...structuredClone(fixture.history[0]),
        id: 'foreign-run',
        projectId: 'another-project',
        createdAt: '2026-09-29T01:00:00.000Z',
        result: { ...fixture.history[0].result!, asset: { assetId: 'foreign-image', version: 2 } },
      },
    );
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/v1/nodes/image-target/runs',
      payload: { projectId: fixture.project.id },
    });
    expect(response.statusCode, response.body).toBe(202);
    const run = await completedRun(fixture.runService, response.json().run.id);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.snapshot.inputs[0]).toMatchObject({
      sourceAssetId: fixture.asset.id,
      sourceAssetVersion: 1,
    });
  });
});

describe('图片回显执行投影的范围', () => {
  it.each(['input:firstFrame', 'input:lastFrame', 'input:referenceImage'])(
    '视频的 %s 复用同一冻结图片，不运行图片祖先',
    async (handle) => {
      const fixture = await referenceFixture(handle);
      const canvas = structuredClone(fixture.saved);
      canvas.nodes[2].type = 'video';
      canvas.nodes[2].data.mediaType = 'video';
      const projected = await withConnectedImageResults({
        projectId: fixture.project.id,
        canvas,
        targetNodeId: 'image-target',
        runService: fixture.runService,
      });
      const snapshot = createRunSnapshot(fixture.project.id, projected.canvas, 'image-target');
      expect(snapshot.nodes.map((node) => node.id)).toEqual(['image-source', 'image-target']);
      expect(snapshot.nodes[0].data.mode).toBe('source');
      expect(projected.sourceVersions).toEqual({ 'image-source': 1 });
      expect(canvas.nodes[1].data.mode).toBe('generate');
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('明确运行来源图片本身仍执行原工作流，不把目标变成来源', async () => {
    const fixture = await referenceFixture();
    vi.mocked(fixture.runService.listByProject).mockClear();
    const projected = await withConnectedImageResults({
      projectId: fixture.project.id,
      canvas: fixture.saved,
      targetNodeId: 'image-source',
      runService: fixture.runService,
    });
    expect(projected.canvas).toBe(fixture.saved);
    expect(projected.sourceVersions).toEqual({});
    expect(projected.canvas.nodes[1].data.mode).toBe('generate');
    expect(fixture.runService.listByProject).not.toHaveBeenCalled();
  });

  it('手动覆盖内容不被过去的生成结果替换', async () => {
    const fixture = await referenceFixture();
    const canvas = structuredClone(fixture.saved);
    canvas.nodes[1].data.manualOutput = true;
    canvas.nodes[1].data.assetId = 'manual-image';
    vi.mocked(fixture.runService.listByProject).mockClear();
    const projected = await withConnectedImageResults({
      projectId: fixture.project.id,
      canvas,
      targetNodeId: 'image-target',
      runService: fixture.runService,
    });
    expect(projected.canvas).toBe(canvas);
    expect(projected.canvas.nodes[1].data.assetId).toBe('manual-image');
    expect(fixture.runService.listByProject).not.toHaveBeenCalled();
  });
});

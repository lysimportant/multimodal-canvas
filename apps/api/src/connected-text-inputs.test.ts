import type { CanvasDocument, MediaType, RunRecord } from '@multimodal-canvas/domain';
import { NewApiProvider } from '@multimodal-canvas/providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryAssetStore } from './assets';
import { withConnectedTextInputs } from './connected-text-inputs';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { createNewApiRunExecutor } from './newapi-run-executor';
import { withLocalResourceReferences } from './local-resource-references';
import { MemoryProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService } from './runs';

/** 使用合成文字与内存服务，禁止访问真实供应商。 */
const apps: Array<ReturnType<typeof buildApp>> = [];
/** 包含换行与中文的输入用于确认直接引用不发生翻译、截断或替换。 */
const prompt = 'A cinematic landscape.\n保留此中文标题：春山';

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

/** 构造错误配置图片模型但已经有可直接使用正文的文字节点。 */
function connectedCanvas(mediaType: MediaType = 'image', handle = 'input:prompt'): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'ancestor',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: '不应重跑的祖先',
          mediaType: 'text',
          mode: 'generate',
          modelAlias: 'missing-model',
        },
      },
      {
        id: 'text-source',
        type: 'text',
        position: { x: 300, y: 0 },
        data: {
          label: '已有提示词',
          mediaType: 'text',
          mode: 'generate',
          modelAlias: 'gpt-image-2',
          prompt,
          promptDocument: { version: 1, blocks: [{ type: 'text', text: prompt }] },
          promptSkillId: 'synthetic-skill',
        },
      },
      {
        id: 'target',
        type: mediaType,
        position: { x: 600, y: 0 },
        data: {
          label: '目标',
          mediaType,
          mode: 'generate',
          modelAlias: 'gpt-image-2.5-sunburst',
          parameters: { quality: '4k', aspectRatio: '21:9' },
        },
      },
    ],
    edges: [
      {
        id: 'ancestor-text',
        sourceNodeId: 'ancestor',
        sourceHandle: 'output:text',
        targetNodeId: 'text-source',
        targetHandle: 'input:content',
        order: 0,
      },
      {
        id: 'text-target',
        sourceNodeId: 'text-source',
        sourceHandle: 'output:text',
        targetNodeId: 'target',
        targetHandle: handle,
        order: 0,
      },
    ],
  };
}

/** 提供独立凭据、合成图片回执和可修改的归档历史。 */
async function fixture() {
  const assetStore = new MemoryAssetStore();
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: '连线文字复用' });
  const settingsStore = new MemoryAiSettingsStore('connected-text-test');
  settingsStore.update({
    baseUrl: 'https://provider.example.test/v1',
    apiKey: 'synthetic-text-key',
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
  const canvas = connectedCanvas();
  canvas.nodes[2].data.credentialId = credentialId;
  await projectStore.updateCanvas(project.id, canvas);
  const saved = (await projectStore.getCanvas(project.id))!;
  const history: RunRecord[] = [];
  const runService = new MemoryRunService({ providerName: 'newapi', stepDelayMs: 1 });
  vi.spyOn(runService, 'listByProject').mockImplementation(async () => structuredClone(history));
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ data: [{ b64_json: Buffer.from('synthetic-image').toString('base64') }] }),
    );
  const executor = createNewApiRunExecutor({
    settingsStore,
    providerFactory: {
      createStandard: (options) => new NewApiProvider({ ...options, fetchImpl }),
      createVideo: () => {
        throw new Error('图片 fixture 不允许创建视频 Provider');
      },
    },
  });
  const app = buildApp({
    logger: false,
    assetStore,
    projectStore,
    settingsStore,
    runService,
    runExecutor: executor,
  });
  apps.push(app);
  return { app, assetStore, projectStore, project, saved, history, runService, fetchImpl };
}

/** 等待内存任务终态；不重试创建请求。 */
async function completed(service: MemoryRunService, id: string) {
  for (let index = 0; index < 200; index += 1) {
    const run = await service.get(id);
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('合成任务未在期限内完成');
}

/** 保存含两个版本的 txt，成功运行只绑定第一版，避免跟随可变资源最新版。 */
async function archiveText(context: Awaited<ReturnType<typeof fixture>>) {
  const asset = await context.assetStore.create({
    projectId: context.project.id,
    name: 'generated.txt',
    mediaType: 'text',
    mimeType: 'text/plain',
    content: Buffer.from(prompt),
  });
  await context.assetStore.createVersion(asset.id, {
    content: Buffer.from('unselected later version'),
  });
  context.history.push({
    id: 'previous-text-run',
    projectId: context.project.id,
    targetNodeId: 'text-source',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'text-model',
    snapshot: createRunSnapshot(context.project.id, context.saved, 'text-source'),
    result: {
      provider: 'newapi',
      summary: 'Text',
      targetNodeId: 'text-source',
      mediaType: 'text',
      inputCount: 0,
      asset: { assetId: asset.id, version: 1, mimeType: 'text/plain' },
    },
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:01:00.000Z',
  });
  return asset;
}

describe('已有文字的执行快照', () => {
  it.each(['image', 'video', 'audio', 'text'] as const)(
    '%s 下游直接引用正文并截断文字祖先',
    async (mediaType) => {
      const canvas = connectedCanvas(mediaType);
      const before = structuredClone(canvas);
      const projected = await withConnectedTextInputs({
        projectId: 'project',
        canvas,
        targetNodeId: 'target',
        runService: { listByProject: async () => [] },
      });
      const snapshot = createRunSnapshot('project', projected.canvas, 'target');
      expect(snapshot.nodes.map((node) => node.id)).toEqual(['text-source', 'target']);
      expect(snapshot.nodes[0].data).toMatchObject({ mode: 'source', prompt });
      expect(snapshot.nodes[0].data.modelAlias).toBeUndefined();
      expect(snapshot.inputs[0].snapshot.data.prompt).toBe(prompt);
      expect(canvas).toEqual(before);
    },
  );

  it.each(['input:content', 'input:prompt', 'input:negativePrompt'])(
    '%s 正文按对应角色引用',
    async (handle) => {
      const canvas = connectedCanvas('video', handle);
      const projected = await withConnectedTextInputs({
        projectId: 'project',
        canvas,
        targetNodeId: 'target',
        runService: { listByProject: async () => [] },
      });
      expect(projected.canvas.nodes[1].data).toMatchObject({ mode: 'source', prompt });
      expect(projected.canvas.edges).toEqual(canvas.edges);
    },
  );

  it.each(['blank', 'manual', 'disabled', 'target', 'unrelated'] as const)(
    '%s 不擅自替换来源或执行目标',
    async (condition) => {
      const canvas = connectedCanvas();
      if (condition === 'blank')
        canvas.nodes[1].data = {
          ...canvas.nodes[1].data,
          prompt: 'stale legacy text',
          promptDocument: { version: 1, blocks: [{ type: 'text', text: '  ' }] },
        };
      if (condition === 'manual') canvas.nodes[1].data.manualOutput = true;
      if (condition === 'disabled') canvas.nodes[1].data.enabled = false;
      if (condition === 'unrelated') canvas.edges = [];
      const projected = await withConnectedTextInputs({
        projectId: 'project',
        canvas,
        targetNodeId: condition === 'target' ? 'text-source' : 'target',
        runService: { listByProject: async () => [] },
      });
      expect(projected.canvas).toBe(canvas);
    },
  );
});

describe('文字引用的资源边界', () => {
  it('未生成的资源提及不能被静默压平成资源名称', async () => {
    const canvas = connectedCanvas();
    canvas.nodes[1].data.promptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'm1',
          assetId: 'resource',
          assetVersion: 1,
          mediaType: 'image',
          label: '参考图',
        },
      ],
    };
    await expect(
      withConnectedTextInputs({
        projectId: 'project',
        canvas,
        targetNodeId: 'target',
        runService: { listByProject: async () => [] },
      }),
    ).rejects.toThrow('请先生成文字结果再引用');
    expect(canvas.nodes[1].data.mode).toBe('generate');
  });
});

describe('内存执行的冻结 txt 水合', () => {
  it.each(['image', 'video', 'audio', 'text'] as const)(
    '%s 读取冻结版本而非旧指令，且不污染快照',
    async (mediaType) => {
      const context = await fixture();
      const asset = await archiveText(context);
      const canvas = connectedCanvas(mediaType);
      const projected = await withConnectedTextInputs({
        projectId: context.project.id,
        canvas,
        targetNodeId: 'target',
        runService: context.runService,
      });
      const snapshot = createRunSnapshot(context.project.id, projected.canvas, 'target', {
        frozenAssetRefs: {
          'text-source': {
            assetId: asset.id,
            version: 1,
            contentUrl: projected.canvas.nodes[1].data.contentUrl!,
          },
        },
      });
      const before = structuredClone(snapshot);
      const executor = vi.fn(async (request) => {
        expect(request.snapshot.inputs[0].snapshot.data.prompt).toBeUndefined();
        expect(request.snapshot.inputs[0].snapshot.data.contentUrl).toBe(
          'data:text/plain;base64,' + Buffer.from(prompt).toString('base64'),
        );
        return {
          provider: 'newapi',
          summary: 'Synthetic response',
          targetNodeId: 'target',
          mediaType,
          inputCount: 1,
        };
      });
      const hydratedExecutor = withLocalResourceReferences(
        executor,
        context.assetStore,
        context.projectStore,
        1024 * 1024,
      );
      if (typeof hydratedExecutor !== 'function') throw new Error('Expected a callable executor');
      await hydratedExecutor({ runId: 'synthetic-run', snapshot, attempt: 1 });
      expect(executor).toHaveBeenCalledOnce();
      expect(snapshot).toEqual(before);
    },
  );
});

describe('连线文字到图片的完整提交', () => {
  it.each(['skill-document', 'plain-text', 'archived-txt'] as const)(
    '%s 仅调用一次 images/generations，原样发送正文并保留4K',
    async (kind) => {
      const context = await fixture();
      let assetId: string | undefined;
      if (kind === 'archived-txt') {
        assetId = (await archiveText(context)).id;
        const canvas = structuredClone(context.saved);
        canvas.nodes[1].data.prompt = 'This is the old instruction, not the generated text.';
        canvas.nodes[1].data.promptDocument = {
          version: 1,
          blocks: [{ type: 'text', text: 'Old instruction' }],
        };
        await context.projectStore.updateCanvas(context.project.id, canvas);
      } else if (kind === 'plain-text') {
        const canvas = structuredClone(context.saved);
        delete canvas.nodes[1].data.promptDocument;
        await context.projectStore.updateCanvas(context.project.id, canvas);
      }
      const before = await context.projectStore.getCanvas(context.project.id);
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/target/runs',
        payload: { projectId: context.project.id },
      });
      expect(response.statusCode, response.body).toBe(202);
      const run = await completed(context.runService, response.json().run.id);
      expect(run.status, run.error).toBe('succeeded');
      expect(run.snapshot.nodes.map((node) => node.id)).toEqual(['text-source', 'target']);
      expect(context.fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = context.fetchImpl.mock.calls[0];
      expect(url).toBe('https://provider.example.test/v1/images/generations');
      expect(JSON.parse(request!.body as string)).toMatchObject({
        model: 'gpt-image-2.5-sunburst',
        prompt,
        size: '3840x1648',
      });
      if (assetId)
        expect(run.snapshot.inputs[0]).toMatchObject({
          sourceAssetId: assetId,
          sourceAssetVersion: 1,
        });
      expect(await context.projectStore.getCanvas(context.project.id)).toEqual(before);
    },
  );

  it.each(['archived', 'missing-version', 'missing-result-version', 'foreign-project'] as const)(
    '%s 拒绝无效文字资产，不降级为重跑或旧指令',
    async (condition) => {
      const context = await fixture();
      const asset = await archiveText(context);
      if (condition === 'archived') await context.assetStore.setArchived(asset.id, true);
      if (condition === 'missing-version') context.history[0].result!.asset!.version = 30;
      if (condition === 'missing-result-version') delete context.history[0].result!.asset!.version;
      if (condition === 'foreign-project') {
        const other = await context.projectStore.create({ name: 'Other project' });
        const foreign = await context.assetStore.create({
          projectId: other.id,
          name: 'private.txt',
          mediaType: 'text',
          mimeType: 'text/plain',
          content: Buffer.from('private'),
        });
        context.history[0].result!.asset!.assetId = foreign.id;
      }
      const create = vi.spyOn(context.runService, 'create');
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/nodes/target/runs',
        payload: { projectId: context.project.id },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expect(context.fetchImpl).not.toHaveBeenCalled();
    },
  );
});

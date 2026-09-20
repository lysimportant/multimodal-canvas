import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import type { CanvasDocument } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './fixtures/test-app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService, type RunExecutorRequest } from './runs';
import { type ModelCatalogEntry } from './settings';

const apps: Array<ReturnType<typeof buildApp>> = [];
const now = new Date().toISOString();

function imageModel(id: string, capabilities?: Record<string, unknown>): ModelCatalogEntry {
  return {
    id,
    name: id,
    mediaTypes: ['image'],
    refreshedAt: now,
    ...(capabilities ? { capabilities } : {}),
  };
}

/**
 * 图片编辑画布：来源节点保留自身资产，编辑节点用全新 ID 并冻结来源版本。
 * @param sourceAssetId 来源节点的当前资产 ID。
 * @param editVersion 编辑节点冻结的来源版本；缺省表示提交时解析最新版本。
 * @param editAssetId 编辑节点记录的来源资产；用于构造被替换的来源。
 */
function imageEditCanvas(
  sourceAssetId: string,
  editVersion?: number,
  editAssetId: string = sourceAssetId,
): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_source',
        type: 'image',
        position: { x: 0, y: 0 },
        width: 400,
        height: 266,
        data: {
          label: '原图',
          mediaType: 'image',
          mode: 'source',
          assetId: sourceAssetId,
          contentUrl: `/v1/assets/${sourceAssetId}/content`,
          mimeType: 'image/png',
        },
      },
      {
        id: 'node_edit',
        type: 'image',
        position: { x: 448, y: 0 },
        width: 400,
        height: 266,
        data: {
          label: '修改 原图',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'image-edit-v1',
          prompt: '换成夜景',
          imageEditSource: {
            sourceNodeId: 'node_source',
            assetId: editAssetId,
            ...(editVersion === undefined ? {} : { version: editVersion }),
          },
        },
      },
    ],
    edges: [
      {
        id: 'edge_source_edit',
        sourceNodeId: 'node_source',
        sourceHandle: 'output:image',
        targetNodeId: 'node_edit',
        targetHandle: 'input:imageEdit',
        order: 0,
      },
    ],
  };
}

describe('图片修改运行边界', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'mock');
    for (const mediaType of ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']) {
      vi.stubEnv(`NEW_API_${mediaType}_MODEL`, '');
    }
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
  });

  it.each([
    {
      name: '明确禁用图片编辑',
      capability: false,
      issueCode: 'IMAGE_EDIT_CAPABILITY_UNSUPPORTED',
      reason: 'capability_unsupported',
    },
    {
      name: '声明非法图片上限',
      capability: { maxImages: 0 },
      issueCode: 'IMAGE_EDIT_CAPABILITY_INVALID',
      reason: 'capability_invalid',
    },
  ])(
    '目录$name时在创建 Run 前失败，且不调用 Provider',
    async ({ capability, issueCode, reason }) => {
      const assetStore = new MemoryAssetStore();
      const projectStore = new MemoryProjectStore();
      const settingsStore = new MemoryAiSettingsStore('image-edit-unsupported');
      settingsStore.replaceModels([imageModel('image-edit-v1', { imageEdit: capability })]);
      const project = await projectStore.create({ name: '未声明能力' });
      const source = await assetStore.create({
        projectId: project.id,
        name: 'source.png',
        mediaType: 'image',
        mimeType: 'image/png',
        content: Buffer.from('image-bytes'),
      });
      await projectStore.updateCanvas(project.id, imageEditCanvas(source.id));
      const executor = vi.fn(async (_request: RunExecutorRequest) => ({
        provider: 'mock',
        summary: 'should not run',
        targetNodeId: 'node_edit',
        mediaType: 'image' as const,
        inputCount: 1,
      }));
      const runService = new MemoryRunService({ executor });
      const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
      apps.push(app);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/nodes/node_edit/runs',
        payload: { projectId: project.id },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'IMAGE_EDIT_UNSUPPORTED',
        issues: [
          {
            code: issueCode,
            reason,
            nodeId: 'node_edit',
            modelAlias: 'image-edit-v1',
          },
        ],
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await runService.listByProject(project.id)).toEqual([]);
    },
  );

  it('声明支持时冻结能力与来源版本，来源节点保持原资产', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new MemoryAiSettingsStore('image-edit-supported');
    settingsStore.replaceModels([
      imageModel('image-edit-v1', {
        imageEdit: {
          supported: true,
          mimeTypes: ['image/png'],
          parameters: ['size'],
          max_images: 4,
        },
      }),
    ]);
    const project = await projectStore.create({ name: '声明能力' });
    const source = await assetStore.create({
      projectId: project.id,
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image-bytes'),
    });
    await projectStore.updateCanvas(project.id, imageEditCanvas(source.id));
    const runService = new MemoryRunService({ stepDelayMs: 0 });
    const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_edit/runs',
      payload: { projectId: project.id, parameters: { prompt: '换成夜景' } },
    });

    expect(response.statusCode).toBe(202);
    const internalRun = await runService.get(response.json().run.id);
    expect(internalRun?.snapshot.imageEditCapability).toEqual({
      declared: true,
      maxImages: 4,
      mimeTypes: ['image/png'],
      parameters: ['size'],
    });
    expect(internalRun?.snapshot.nodeImageEditCapabilities).toEqual({
      node_edit: { declared: true, maxImages: 4, mimeTypes: ['image/png'], parameters: ['size'] },
    });
    const sourceNode = internalRun?.snapshot.nodes.find((node) => node.id === 'node_source');
    expect(sourceNode?.data.assetId).toBe(source.id);
    expect(sourceNode?.data.contentUrl).toBe(
      `/v1/assets/${encodeURIComponent(source.id)}/versions/1/content`,
    );
    expect(internalRun?.snapshot.inputs[0]).toMatchObject({
      nodeId: 'node_source',
      role: 'imageEdit',
      sourceAssetId: source.id,
    });
    // 画布上的来源节点不被运行改写。
    const savedCanvas = await projectStore.getCanvas(project.id);
    expect(savedCanvas?.nodes[0].data.assetId).toBe(source.id);
    expect(savedCanvas?.nodes[0].data.contentUrl).toBe(`/v1/assets/${source.id}/content`);
  });

  it('编辑节点冻结的来源版本优先于之后产生的新版本', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new MemoryAiSettingsStore('image-edit-pinned');
    settingsStore.replaceModels([imageModel('image-edit-v1')]);
    const project = await projectStore.create({ name: '固定版本' });
    const source = await assetStore.create({
      projectId: project.id,
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image-v1'),
    });
    await assetStore.createVersion(source.id, {
      content: Buffer.from('image-v2'),
    });
    await projectStore.updateCanvas(project.id, imageEditCanvas(source.id, 1));
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_edit/runs',
      payload: { projectId: project.id },
    });

    expect(response.statusCode).toBe(202);
    const internalRun = await runService.get(response.json().run.id);
    expect(internalRun?.snapshot.imageEditCapability).toBeUndefined();
    expect(internalRun?.snapshot.nodeImageEditCapabilities).toBeUndefined();
    const sourceNode = internalRun?.snapshot.nodes.find((node) => node.id === 'node_source');
    expect(sourceNode?.data.contentUrl).toBe(
      `/v1/assets/${encodeURIComponent(source.id)}/versions/1/content`,
    );
  });

  it('冻结版本不可用时阻止运行并给出可操作错误', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new MemoryAiSettingsStore('image-edit-version-missing');
    settingsStore.replaceModels([imageModel('image-edit-v1', { imageEdit: true })]);
    const project = await projectStore.create({ name: '版本缺失' });
    const source = await assetStore.create({
      projectId: project.id,
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image-v1'),
    });
    await projectStore.updateCanvas(project.id, imageEditCanvas(source.id, 7));
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_edit/runs',
      payload: { projectId: project.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'asset_version_unavailable' });
    expect(await runService.listByProject(project.id)).toEqual([]);
  });

  it('来源节点换成另一张图时阻止运行并保留节点与边', async () => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new MemoryAiSettingsStore('image-edit-replaced');
    settingsStore.replaceModels([imageModel('image-edit-v1', { imageEdit: true })]);
    const project = await projectStore.create({ name: '来源被替换' });
    const original = await assetStore.create({
      projectId: project.id,
      name: 'original.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image-v1'),
    });
    const replacement = await assetStore.create({
      projectId: project.id,
      name: 'replacement.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image-v2'),
    });
    await projectStore.updateCanvas(project.id, imageEditCanvas(replacement.id, 1, original.id));
    const runService = new MemoryRunService();
    const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_edit/runs',
      payload: { projectId: project.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'IMAGE_EDIT_UNSUPPORTED',
      issues: [{ code: 'IMAGE_EDIT_SOURCE_ASSET_MISMATCH' }],
    });
    const savedCanvas = await projectStore.getCanvas(project.id);
    expect(savedCanvas?.nodes).toHaveLength(2);
    expect(savedCanvas?.edges).toHaveLength(1);
  });

  it.each([true, false])('逐个执行节点检查编辑模型，支持状态为 %s', async (supported) => {
    const assetStore = new MemoryAssetStore();
    const projectStore = new MemoryProjectStore();
    const settingsStore = new MemoryAiSettingsStore('image-edit-workflow');
    settingsStore.replaceModels([
      imageModel('image-edit-v1', { imageEdit: { supported, mimeTypes: ['image/png'] } }),
      imageModel('image-target-v1', { imageEdit: { supported: true, mimeTypes: ['image/jpeg'] } }),
    ]);
    const project = await projectStore.create({ name: '按节点编辑能力' });
    const source = await assetStore.create({
      projectId: project.id,
      name: 'source.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('image'),
    });
    const canvas = imageEditCanvas(source.id);
    canvas.nodes.push({
      id: 'node_target',
      type: 'image',
      position: { x: 896, y: 0 },
      data: {
        label: '下游图片',
        mediaType: 'image',
        mode: 'generate',
        modelAlias: 'image-target-v1',
        prompt: 'Change the background.',
      },
    });
    canvas.edges.push({
      id: 'edit_target',
      sourceNodeId: 'node_edit',
      sourceHandle: 'output:image',
      targetNodeId: 'node_target',
      targetHandle: 'input:referenceImage',
      order: 0,
    });
    await projectStore.updateCanvas(project.id, canvas);
    const runService = new MemoryRunService({ stepDelayMs: 0 });
    const app = buildApp({ logger: false, assetStore, projectStore, settingsStore, runService });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    if (!supported) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'IMAGE_EDIT_UNSUPPORTED',
        issues: [
          {
            nodeId: 'node_edit',
            modelAlias: 'image-edit-v1',
            code: 'IMAGE_EDIT_CAPABILITY_UNSUPPORTED',
          },
        ],
      });
      expect(await runService.listByProject(project.id)).toEqual([]);
      return;
    }
    expect(response.statusCode).toBe(202);
    const run = await runService.get(response.json().run.id);
    expect(run?.snapshot.nodeImageEditCapabilities).toEqual({
      node_edit: { declared: true, maxImages: 1, mimeTypes: ['image/png'] },
      node_target: { declared: true, maxImages: 1, mimeTypes: ['image/jpeg'] },
    });
    expect(run?.snapshot.imageEditCapability).toEqual({
      declared: true,
      maxImages: 1,
      mimeTypes: ['image/jpeg'],
    });
  });
});

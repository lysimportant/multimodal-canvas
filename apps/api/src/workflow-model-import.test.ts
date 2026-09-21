import type { CanvasDocument } from '@multimodal-canvas/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowExport } from './export';
import { MemoryAiSettingsStore } from './fixtures/memory-ai-settings';
import { buildApp } from './fixtures/test-app';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

/** 只使用内存目录和执行器；测试不会请求任何供应商。 */
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 构造一个或两个分组的同名文字模型，复现分组身份被导出移除后的导入。 */
async function fixture(groupCount = 2) {
  vi.stubEnv('WORKER_PROVIDER', 'newapi');
  const settingsStore = new MemoryAiSettingsStore();
  const credentialIds: string[] = [];
  for (let index = 0; index < groupCount; index += 1) {
    const baseUrl = `https://group-${index}.example.invalid/v1`;
    settingsStore.update({ baseUrl, apiKey: `synthetic-import-group-${index}` });
    const credential = settingsStore.listCredentials().find((entry) => entry.baseUrl === baseUrl)!;
    credentialIds.push(credential.id);
    settingsStore.replaceModels(
      [
        {
          id: 'shared-text',
          name: 'shared-text',
          mediaTypes: ['text'],
          refreshedAt: new Date().toISOString(),
        },
      ],
      credential.id,
    );
  }
  const projectStore = new MemoryProjectStore();
  const project = await projectStore.create({ name: '导入目标' });
  const runService = new MemoryRunService({ providerName: 'newapi' });
  const createRun = vi.spyOn(runService, 'create');
  const app = buildApp({ logger: false, settingsStore, projectStore, runService });
  apps.push(app);
  const canvas: CanvasDocument = {
    revision: 0,
    nodes: [
      {
        id: 'imported-text',
        type: 'text',
        position: { x: 123, y: 456 },
        data: {
          label: '保留原内容',
          mediaType: 'text',
          mode: 'generate',
          prompt: 'Original prompt',
          modelAlias: 'shared-text',
          credentialId: credentialIds[0],
          parameters: { temperature: 0.4 },
        },
      },
    ],
    edges: [],
  };
  const workflow = createWorkflowExport({
    project,
    canvas,
    runs: [],
    modelDefaults: { text: { modelAlias: 'shared-text', credentialId: credentialIds[0] } },
  });
  return { app, project, projectStore, credentialIds, workflow, createRun };
}

describe('New API 工作流模型导入', () => {
  it('多组同名模型的导出文件可导入，保留内容和模型建议并提示重选分组', async () => {
    const { app, project, projectStore, workflow, createRun } = await fixture();
    expect(workflow.modelDefaults).toEqual({ text: { modelAlias: 'shared-text' } });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/workflow`,
      payload: { workflow, expectedRevision: 0 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().canvas.nodes).toEqual(workflow.canvas.nodes);
    expect(response.json().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MODEL_SELECTION_REQUIRED',
          nodeId: 'imported-text',
          modelAlias: 'shared-text',
        }),
        expect.objectContaining({
          code: 'MODEL_SELECTION_REQUIRED',
          mediaType: 'text',
          modelAlias: 'shared-text',
        }),
      ]),
    );
    expect(await projectStore.getModelDefaults(project.id)).toEqual({ text: 'shared-text' });
    expect(createRun).not.toHaveBeenCalled();
  });

  it('导入中的他人凭据和密钥不会进入画布、项目默认或返回文档', async () => {
    const { app, project, projectStore, workflow } = await fixture();
    workflow.canvas.nodes[0]!.data.credentialId = 'foreign-credential';
    workflow.modelDefaults = {
      text: { modelAlias: 'shared-text', credentialId: 'foreign-credential' },
    };
    workflow.runs = [{ apiKey: 'synthetic-secret-to-remove', credentialId: 'foreign-credential' }];
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/workflow`,
      payload: workflow,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('foreign-credential');
    expect(response.body).not.toContain('synthetic-secret-to-remove');
    expect((await projectStore.getCanvas(project.id))!.nodes[0]!.data).not.toHaveProperty(
      'credentialId',
    );
    expect(await projectStore.getModelDefaults(project.id)).toEqual({ text: 'shared-text' });
  });

  it.each(['node', 'project'] as const)(
    '仅一个可用分组时也不为导入的 %s 模型建议自动选择凭据',
    async (selectionScope) => {
      const { app, project, projectStore, workflow, createRun } = await fixture(1);
      if (selectionScope === 'project') delete workflow.canvas.nodes[0]!.data.modelAlias;
      await projectStore.updateCanvas(project.id, workflow.canvas);
      await projectStore.updateModelDefaults(project.id, workflow.modelDefaults!);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/nodes/imported-text/runs',
        payload: { projectId: project.id },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'model_unavailable' });
      expect(createRun).not.toHaveBeenCalled();
    },
  );

  it('保留当前不可用的精确模型建议，不阻止画布内容导入', async () => {
    const { app, project, workflow } = await fixture();
    workflow.modelDefaults = { video: 'Unavailable-Exact-Model' };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/workflow`,
      payload: workflow,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().modelDefaults).toEqual({ video: 'Unavailable-Exact-Model' });
    expect(response.json().issues).toContainEqual(
      expect.objectContaining({
        code: 'MODEL_SELECTION_REQUIRED',
        mediaType: 'video',
        modelAlias: 'Unavailable-Exact-Model',
      }),
    );
  });

  it('普通默认模型保存必须指定分组，不能把唯一候选当作用户选择', async () => {
    const { app, project, projectStore } = await fixture(1);
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/models/defaults`,
      payload: { text: { modelAlias: 'shared-text' } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'model_unavailable' });
    expect(await projectStore.getModelDefaults(project.id)).toEqual({});
  });

  it('用户显式重选分组后仍按该凭据创建任务', async () => {
    const { app, project, projectStore, workflow, credentialIds, createRun } = await fixture();
    await projectStore.updateCanvas(project.id, workflow.canvas);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/nodes/imported-text/runs',
      payload: { projectId: project.id, modelAlias: 'shared-text', credentialId: credentialIds[1] },
    });
    expect(response.statusCode).toBe(202);
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun.mock.calls[0][0]).toMatchObject({ credentialId: credentialIds[1] });
  });

  it.each([42, {}, { platformModelId: 'retired-model' }, { modelAlias: 12 }])(
    '无效默认模型 %j 返回 400 且不部分写入',
    async (invalidDefault) => {
      const { app, project, projectStore, workflow } = await fixture();
      const before = await projectStore.getCanvas(project.id);
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.id}/import/workflow`,
        payload: { ...workflow, modelDefaults: { text: invalidDefault } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'invalid_schema' });
      expect(await projectStore.getCanvas(project.id)).toEqual(before);
      expect(await projectStore.getModelDefaults(project.id)).toEqual({});
    },
  );
});

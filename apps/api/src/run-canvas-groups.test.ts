import type { CanvasDocument } from '@multimodal-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from './app';
import { MemoryAssetStore } from './assets';
import { MemoryProjectStore } from './projects';
import { MemoryRunService } from './runs';

/**
 * 一份带分组的画布：两个媒体节点同属一个组。
 *
 * 组只表达布局，因此这里刻意让组覆盖所有节点，用于证明分组不会改变
 * 请求内容、执行顺序或节点数量。
 */
function groupedCanvas(groups: CanvasDocument['groups']): CanvasDocument {
  return {
    revision: 0,
    nodes: [
      {
        id: 'node_source',
        type: 'text',
        position: { x: 0, y: 0 },
        data: { label: '来源', mediaType: 'text', mode: 'source', prompt: '上游提示词' },
      },
      {
        id: 'node_target',
        type: 'text',
        position: { x: 320, y: 0 },
        data: { label: '生成', mediaType: 'text', mode: 'generate' },
      },
    ],
    edges: [
      {
        id: 'edge_source_target',
        sourceNodeId: 'node_source',
        sourceHandle: 'output:text',
        targetNodeId: 'node_target',
        targetHandle: 'input:prompt',
        order: 0,
      },
    ],
    ...(groups ? { groups } : {}),
  };
}

const layoutGroup: NonNullable<CanvasDocument['groups']> = [
  {
    id: 'group_scene',
    name: '场景 A',
    position: { x: -40, y: -40 },
    width: 800,
    height: 500,
    nodeIds: ['node_source', 'node_target'],
  },
];

describe('canvas groups never enter the run DAG', () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];

  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WORKER_PROVIDER', 'mock');
    vi.stubEnv('API_AUTH_TOKEN', '');
    vi.stubEnv('API_JWT_SECRET', '');
    for (const mediaType of ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO']) {
      vi.stubEnv(`NEW_API_${mediaType}_MODEL`, '');
    }
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    vi.unstubAllEnvs();
  });

  /** 提交一次运行并返回内部快照，用于与无分组画布逐项比较。 */
  async function submitRun(canvas: CanvasDocument) {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '分组与运行' });
    await projectStore.updateCanvas(project.id, canvas);
    const runService = new MemoryRunService({ stepDelayMs: 5 });
    const app = buildApp({
      logger: false,
      assetStore: new MemoryAssetStore(),
      projectStore,
      runService,
    });
    apps.push(app);

    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/nodes/node_target/runs',
      payload: { projectId: project.id },
    });
    expect(submitted.statusCode).toBe(202);
    const internal = await runService.get(submitted.json().run.id);
    expect(internal).toBeDefined();
    return internal!;
  }

  it('运行快照只包含参与执行的媒体节点与业务边，不含分组字段', async () => {
    const run = await submitRun(groupedCanvas(layoutGroup));
    expect(run.snapshot.nodes.map((node) => node.id)).toEqual(['node_source', 'node_target']);
    expect(run.snapshot.edges.map((edge) => edge.id)).toEqual(['edge_source_target']);
    // 快照契约里没有组字段；分组不得出现在请求内容中。
    expect(Object.keys(run.snapshot)).not.toContain('groups');
    expect(JSON.stringify(run.snapshot)).not.toContain('group_scene');
    expect(JSON.stringify(run.snapshot)).not.toContain('场景 A');
  });

  it('有无分组不改变请求内容、执行顺序与节点数量', async () => {
    const grouped = await submitRun(groupedCanvas(layoutGroup));
    const ungrouped = await submitRun(groupedCanvas(undefined));

    expect(grouped.snapshot.nodes.map((node) => node.id)).toEqual(
      ungrouped.snapshot.nodes.map((node) => node.id),
    );
    expect(grouped.snapshot.edges.map((edge) => edge.id)).toEqual(
      ungrouped.snapshot.edges.map((edge) => edge.id),
    );
    expect(grouped.snapshot.inputs.map((input) => input.nodeId)).toEqual(
      ungrouped.snapshot.inputs.map((input) => input.nodeId),
    );
    expect(grouped.snapshot.inputs.map((input) => input.role)).toEqual(
      ungrouped.snapshot.inputs.map((input) => input.role),
    );
    expect(grouped.snapshot.modelAlias).toBe(ungrouped.snapshot.modelAlias);
  });

  it('分组本身仍然持久化在画布文档里，不被运行链路丢弃', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '分组持久化' });
    await projectStore.updateCanvas(project.id, groupedCanvas(layoutGroup));
    expect((await projectStore.getCanvas(project.id))?.groups).toEqual(layoutGroup);
  });

  it('拒绝省略分组的旧客户端保存，显式清空分组时保留媒体节点', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '旧客户端兼容' });
    const saved = await projectStore.updateCanvas(project.id, groupedCanvas(layoutGroup));
    const app = buildApp({ logger: false, projectStore });
    apps.push(app);

    const oldClient = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: { ...groupedCanvas(undefined), revision: saved.revision },
    });
    expect(oldClient.statusCode).toBe(409);
    expect(oldClient.json()).toMatchObject({ code: 'incompatible_canvas' });
    expect(await projectStore.getCanvas(project.id)).toEqual(saved);

    const ungroup = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${project.id}/canvas`,
      payload: { ...saved, groups: [] },
    });
    expect(ungroup.statusCode).toBe(200);
    expect(ungroup.json().canvas.groups).toEqual([]);
    expect(ungroup.json().canvas.nodes).toEqual(saved.nodes);
  });

  it('导入旧工作流时显式解除目标分组并保留导入节点', async () => {
    const projectStore = new MemoryProjectStore();
    const project = await projectStore.create({ name: '导入兼容' });
    const saved = await projectStore.updateCanvas(project.id, groupedCanvas(layoutGroup));
    const app = buildApp({ logger: false, projectStore });
    apps.push(app);
    const exported = await app.inject({
      method: 'GET',
      url: `/v1/projects/${project.id}/export/workflow`,
    });
    expect(exported.statusCode).toBe(200);
    const legacy = exported.json();
    delete legacy.canvas.groups;
    const imported = await app.inject({
      method: 'POST',
      url: `/v1/projects/${project.id}/import/workflow`,
      payload: { workflow: legacy, expectedRevision: saved.revision },
    });
    expect(imported.statusCode).toBe(200);
    expect((await projectStore.getCanvas(project.id))?.groups).toEqual([]);
    expect((await projectStore.getCanvas(project.id))?.nodes).toEqual(saved.nodes);
  });
});

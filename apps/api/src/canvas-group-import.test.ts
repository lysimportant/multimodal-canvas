import { describe, expect, it } from 'vitest';

import type { CanvasDocument } from '@multimodal-canvas/domain';

import { MemoryAssetStore } from './assets';
import { importWorkflowExport, parseWorkflowExport, WorkflowImportError } from './workflow-import';

/**
 * 导入导出往返使用的画布：两个媒体节点同属一个组。
 *
 * 组只是布局，因此这里不包含任何连线、端口或运行相关内容。
 */
function canvasWithGroup(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
  return {
    revision: 4,
    nodes: [
      {
        id: 'node-image',
        type: 'image',
        position: { x: 100, y: 120 },
        width: 400,
        height: 266,
        data: { label: '图片', mediaType: 'image', mode: 'generate', prompt: '一只猫' },
      },
      {
        id: 'node-text',
        type: 'text',
        position: { x: 560, y: 120 },
        width: 270,
        height: 246,
        data: { label: '文案', mediaType: 'text', mode: 'generate', prompt: '写一句标题' },
      },
    ],
    edges: [],
    groups: [
      {
        id: 'group-1',
        name: '场景 A',
        position: { x: 60, y: 60 },
        width: 820,
        height: 400,
        nodeIds: ['node-image', 'node-text'],
      },
    ],
    ...overrides,
  } satisfies CanvasDocument;
}

function workflowForCanvas(canvas: CanvasDocument) {
  return {
    schemaVersion: 1,
    exportedAt: '2026-09-16T00:00:00.000Z',
    project: {
      id: 'project-source',
      name: '分组往返',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    },
    canvas,
    runs: [],
    results: [],
  };
}

describe('canvas group import and export', () => {
  it('解析导出文件时保留组布局', () => {
    const parsed = parseWorkflowExport(workflowForCanvas(canvasWithGroup()));
    expect(parsed.canvas.groups).toEqual(canvasWithGroup().groups);
  });

  it('跨项目导入分配新节点身份，保留组与成员顺序及绝对坐标', async () => {
    const result = await importWorkflowExport(workflowForCanvas(canvasWithGroup()), {
      assetStore: new MemoryAssetStore(),
      projectId: 'project-target',
    });
    expect(result.canvas.groups).toEqual([
      {
        ...canvasWithGroup().groups![0],
        nodeIds: ['node-image', 'node-text'].map((id) => result.nodeIdMap[id]),
      },
    ]);
    expect(result.canvas.nodes.map((node) => node.id)).toEqual([
      result.nodeIdMap['node-image'],
      result.nodeIdMap['node-text'],
    ]);
    expect(result.nodeIdMap['node-image']).not.toBe('node-image');
    expect(result.nodeIdMap['node-text']).not.toBe('node-text');
    expect(result.canvas.nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 120 },
      { x: 560, y: 120 },
    ]);
  });

  it('跨项目重新映射连线、批量根、完成动作目标和图片编辑来源', async () => {
    const assetStore = new MemoryAssetStore();
    const asset = await assetStore.create({
      projectId: 'project-target',
      name: 'original.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: Buffer.from('version-one'),
    });
    await assetStore.createVersion(asset.id, { content: Buffer.from('version-two') });
    await assetStore.createVersion(asset.id, { content: Buffer.from('version-three') });
    const canvas = canvasWithGroup();
    canvas.nodes[0].data.generationBatch = { id: 'batch', rootNodeId: 'node-image', index: 0 };
    canvas.nodes[0].data.completionTargetNodeId = 'node-text';
    canvas.nodes[0].data.imageEditSource = {
      sourceNodeId: 'node-text',
      assetId: asset.id,
      version: 3,
    };
    canvas.edges = [
      {
        id: 'edge-original',
        sourceNodeId: 'node-text',
        sourceHandle: 'output:text',
        targetNodeId: 'node-image',
        targetHandle: 'input:prompt',
        order: 0,
      },
    ];
    const source = structuredClone(canvas);
    const result = await importWorkflowExport(workflowForCanvas(canvas), {
      assetStore,
      projectId: 'project-target',
    });
    expect(result.canvas.edges[0]).toEqual({
      ...canvas.edges[0],
      id: expect.any(String),
      sourceNodeId: result.nodeIdMap['node-text'],
      targetNodeId: result.nodeIdMap['node-image'],
    });
    expect(result.canvas.edges[0].id).not.toBe('edge-original');
    expect(result.canvas.nodes[0].data).toMatchObject({
      generationBatch: { id: 'batch', rootNodeId: result.nodeIdMap['node-image'], index: 0 },
      completionTargetNodeId: result.nodeIdMap['node-text'],
      imageEditSource: {
        sourceNodeId: result.nodeIdMap['node-text'],
        assetId: asset.id,
        version: 3,
      },
    });
    expect(result.canvas.nodes.map(({ id, ...node }) => node)).toMatchObject(
      source.nodes.map(({ id, data, ...node }) => node),
    );
    expect(canvas).toEqual(source);
  });

  it('旧导出文件没有 groups 字段时按空组导入', async () => {
    const legacy = canvasWithGroup();
    delete (legacy as { groups?: unknown }).groups;
    const result = await importWorkflowExport(workflowForCanvas(legacy), {
      assetStore: new MemoryAssetStore(),
    });
    expect(result.canvas.groups).toBeUndefined();
  });

  it('重复组 ID、缺失成员与重复归属让导入整体失败而不是静默丢组', () => {
    const group = {
      id: 'group-1',
      name: 'G',
      position: { x: 0, y: 0 },
      width: 400,
      height: 400,
    };
    for (const groups of [
      [group, { ...group, name: 'H' }],
      [{ ...group, nodeIds: ['ghost'] }],
      [
        { ...group, nodeIds: ['node-image'] },
        { ...group, id: 'group-2', nodeIds: ['node-image'] },
      ],
    ]) {
      expect(() =>
        parseWorkflowExport(workflowForCanvas(canvasWithGroup({ groups } as never))),
      ).toThrowError(WorkflowImportError);
    }
  });

  it('组不进入运行图：导入后的节点与边集合不因分组变化', async () => {
    const grouped = await importWorkflowExport(workflowForCanvas(canvasWithGroup()), {
      assetStore: new MemoryAssetStore(),
    });
    const ungrouped = await importWorkflowExport(
      workflowForCanvas(canvasWithGroup({ groups: [] })),
      { assetStore: new MemoryAssetStore() },
    );
    expect(grouped.canvas.nodes.map((node) => node.id)).toEqual(
      ungrouped.canvas.nodes.map((node) => node.id),
    );
    expect(grouped.canvas.edges).toEqual(ungrouped.canvas.edges);
  });
});

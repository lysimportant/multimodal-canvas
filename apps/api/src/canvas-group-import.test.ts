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

  it('导入时按原身份保留组与成员顺序，不把成员坐标改成组内相对坐标', async () => {
    const result = await importWorkflowExport(workflowForCanvas(canvasWithGroup()), {
      assetStore: new MemoryAssetStore(),
      projectId: 'project-target',
    });
    expect(result.canvas.groups).toEqual(canvasWithGroup().groups);
    expect(result.canvas.nodes.map((node) => node.position)).toEqual([
      { x: 100, y: 120 },
      { x: 560, y: 120 },
    ]);
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

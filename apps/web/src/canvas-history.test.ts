import type { RunRecord } from '@multimodal-canvas/domain';
import { describe, expect, it, vi } from 'vitest';
import { CanvasHistory } from './canvas-history';
import type { CanvasSnapshot } from './canvas-persistence';
import { translateGroup, pruneGroupMembers } from './canvas-utils';

/** 三个节点、两条边和一个组，全部为内存合成数据。 */
function canvas(): CanvasSnapshot {
  return {
    nodes: ['a', 'b', 'c'].map((id, index) => ({
      id,
      type: 'text',
      position: { x: index * 300, y: 100 },
      width: 230,
      height: 216,
      selected: index < 2,
      data: { label: id, mode: 'generate', mediaType: 'text', prompt: '原提示词' },
    })),
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
    ],
    groups: [
      {
        id: 'g',
        name: '组',
        position: { x: 0, y: 0 },
        width: 900,
        height: 500,
        nodeIds: ['a', 'b'],
      },
    ],
  };
}

/** 构造完成运行，供删除期间收到结果及撤销时的权威运行状态合并使用。 */
function completedRun(): RunRecord {
  return {
    id: 'run-a',
    projectId: 'synthetic',
    targetNodeId: 'a',
    status: 'succeeded',
    progress: 100,
    attempt: 1,
    provider: 'fixture',
    modelAlias: 'fixture',
    createdAt: '2026-10-02T00:00:00Z',
    updatedAt: '2026-10-02T00:01:00Z',
    result: {
      mediaType: 'text',
      targetNodeId: 'a',
      provider: 'fixture',
      summary: '合成结果',
      inputCount: 0,
      asset: {
        assetId: 'result-a',
        mimeType: 'text/plain',
        contentUrl: '/synthetic/result',
        version: 1,
      },
    },
    snapshot: {
      projectId: 'synthetic',
      canvasRevision: 1,
      targetNodeId: 'a',
      modelAlias: 'fixture',
      parameters: {},
      submittedAt: '2026-10-02T00:00:00Z',
      nodes: [],
      edges: [],
      inputs: [],
    },
  };
}

describe('结构共享画布历史', () => {
  it('多选删除连同边和组成员一次恢复/重做，保留未编辑对象且不克隆或 JSON 比较', () => {
    const original = canvas();
    const history = new CanvasHistory();
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const encode = vi.spyOn(JSON, 'stringify');
    history.remember(original);
    const deleted = {
      nodes: original.nodes.slice(2),
      edges: [],
      groups: pruneGroupMembers(original.groups, ['c']),
    };
    expect(history.past[0]).toBe(original);
    const undo = history.undo(deleted, {})!;
    expect(undo).toEqual(original);
    expect(undo.nodes[2]).toBe(original.nodes[2]);
    expect(history.redo(undo, {})).toEqual(deleted);
    expect(clone).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
    expect(original.groups[0].nodeIds).toEqual(['a', 'b']);
  });

  it('整组移动、组外框与组名修改、解散组按步骤撤销并可重做', () => {
    const original = canvas();
    const history = new CanvasHistory();
    history.remember(original);
    const moved = {
      ...original,
      ...translateGroup({ ...original, groupId: 'g', delta: { x: 40, y: 20 } })!,
    };
    history.remember(moved);
    const resized = {
      ...moved,
      groups: moved.groups.map((group) => ({ ...group, width: 1100, name: '新组名' })),
    };
    history.remember(resized);
    const dissolved = { ...resized, groups: [] };
    const undo1 = history.undo(dissolved, {})!;
    expect(undo1).toEqual(resized);
    const undo2 = history.undo(undo1, {})!;
    expect(undo2).toEqual(moved);
    const undo3 = history.undo(undo2, {})!;
    expect(undo3).toEqual(original);
    expect(history.redo(undo3, {})).toEqual(moved);
  });

  it('一轮多选拖动只保存开始快照，60 帧后一次撤销恢复全部坐标', () => {
    const original = canvas();
    const history = new CanvasHistory();
    history.remember(original);
    let current = original;
    for (let frame = 0; frame < 60; frame++) {
      current = {
        ...current,
        nodes: current.nodes.map((node) =>
          node.selected
            ? { ...node, position: { x: node.position.x + 1, y: node.position.y + 2 } }
            : node,
        ),
      };
    }
    expect(history.past).toHaveLength(1);
    expect(history.undo(current, {})).toEqual(original);
    expect(history.redo(original, {})).toEqual(current);
  });

  it('撤销/重做提示词不回滚进行中的进度、已完成结果或节点删除期间的运行更新', () => {
    const original = canvas();
    const history = new CanvasHistory();
    history.remember(original);
    const edited = {
      ...original,
      nodes: original.nodes.map((node, i) =>
        i
          ? node
          : {
              ...node,
              data: {
                ...node.data,
                prompt: '新提示词',
                runStatus: 'running' as const,
                runProgress: 60,
              },
            },
      ),
    };
    const undo = history.undo(edited, {})!;
    expect(undo.nodes[0].data).toMatchObject({
      prompt: '原提示词',
      runStatus: 'running',
      runProgress: 60,
    });
    const runs = { a: completedRun() };
    const redo = history.redo(undo, runs)!;
    expect(redo.nodes[0].data).toMatchObject({
      prompt: '新提示词',
      runStatus: 'succeeded',
      runProgress: 100,
      resultAsset: runs.a.result!.asset,
    });
    history.remember(redo);
    const restored = history.undo({ nodes: [], edges: [], groups: [] }, runs)!;
    expect(restored.nodes[0].data.resultAsset).toBe(runs.a.result!.asset);
    expect(restored.nodes[0].data.runStatus).toBe('succeeded');
  });

  it('运行完成后恢复节点不会复活同一运行已清除的手工输出标志', () => {
    const source = canvas();
    source.nodes[0] = {
      ...source.nodes[0],
      data: { ...source.nodes[0].data, manualOutput: true, manualOutputRunId: 'run-a' },
    };
    const history = new CanvasHistory();
    history.remember(source);
    const restored = history.undo({ nodes: [], edges: [], groups: [] }, { a: completedRun() })!;
    expect(restored.nodes[0].data.manualOutput).toBeUndefined();
    expect(restored.nodes[0].data.resultAsset?.assetId).toBe('result-a');
  });

  it('保留 50 步上限、跳过空拖拽，撤销后的新编辑丢弃 redo 分支', () => {
    const history = new CanvasHistory();
    let current = canvas();
    history.remember(current);
    history.remember({
      ...current,
      nodes: current.nodes.map((node) => ({
        ...node,
        selected: false,
        measured: { width: 230, height: 216 },
      })),
    });
    expect(history.past).toHaveLength(1);
    expect(history.undo(current, {})).toBeUndefined();
    for (let index = 0; index < 55; index++) {
      history.remember(current);
      current = {
        ...current,
        nodes: current.nodes.map((node) => ({
          ...node,
          position: { ...node.position, x: node.position.x + 1 },
        })),
      };
    }
    expect(history.past).toHaveLength(50);
    const previous = history.undo(current, {})!;
    expect(history.future).toHaveLength(1);
    history.remember(previous);
    expect(history.future).toHaveLength(0);
    expect(history.redo(previous, {})).toBeUndefined();
  });
});

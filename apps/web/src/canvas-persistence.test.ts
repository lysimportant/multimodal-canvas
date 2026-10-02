import { describe, expect, it, vi } from 'vitest';
import { toCanvasDocument } from './canvas-utils';
import { CanvasPersistence, sameCanvasContent, type CanvasSnapshot } from './canvas-persistence';

/** 含运行字段、默认端口及待裁剪成员的合成画布，用于对照既有文档格式。 */
function canvas(): CanvasSnapshot {
  return {
    nodes: ['a', 'b'].map((id, index) => ({
      id,
      type: 'text',
      position: { x: index * 300, y: 100 },
      width: 230,
      height: 216,
      selected: true,
      data: {
        label: id,
        mode: 'generate',
        mediaType: 'text',
        prompt: '合成提示词',
        parameters: { temperature: 0.7 },
        runStatus: 'running',
        runProgress: 25,
      },
    })),
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ab-2', source: 'a', target: 'b' },
    ],
    groups: [
      {
        id: 'g',
        name: '组',
        position: { x: 0, y: 0 },
        width: 900,
        height: 500,
        nodeIds: ['a', 'missing', 'b'],
      },
    ],
  };
}

describe('画布持久化快照复用', () => {
  it('与既有编码逐字段兼容，保留端口顺序和组清理，不持久化 UI 或运行字段', () => {
    const source = canvas();
    source.nodes[0] = { ...source.nodes[0], width: Number.NaN };
    const snapshot = new CanvasPersistence().capture(source);
    expect(JSON.parse(snapshot.serialize(9))).toEqual(
      toCanvasDocument(source.nodes, source.edges, 9, source.groups),
    );
    expect(snapshot.source).toBe(source);
  });

  it('草稿、保存、409 重试和保存回执复用同一次整图编码', () => {
    const cache = new CanvasPersistence();
    const source = canvas();
    const encode = vi.spyOn(JSON, 'stringify');
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const draft = cache.capture(source).serialize(1);
    const request = cache.capture(source).serialize(1);
    const retry = cache.capture(source).serialize(5);
    const acknowledged = cache.capture(source).serialize(6);
    expect(encode.mock.calls.filter(([value]) => typeof value === 'object')).toHaveLength(1);
    expect(clone).not.toHaveBeenCalled();
    expect(draft).toBe(request);
    expect(JSON.parse(retry)).toEqual({ ...JSON.parse(request), revision: 5 });
    expect(JSON.parse(acknowledged).revision).toBe(6);
  });

  it('保存期间继续编辑不会修改冻结请求，也不能把新内容标成已保存', () => {
    const source = canvas();
    const cache = new CanvasPersistence();
    const first = cache.capture(source);
    const edited = {
      ...source,
      nodes: source.nodes.map((node, i) =>
        i ? node : { ...node, data: { ...node.data, prompt: '新提示词' } },
      ),
    };
    const second = cache.capture(edited);
    expect(first.matches(edited)).toBe(false);
    expect(second).not.toBe(first);
    expect(JSON.parse(first.serialize(2)).nodes[0].data.prompt).toBe('合成提示词');
    expect(JSON.parse(second.serialize(3)).nodes[0].data.prompt).toBe('新提示词');
    expect(source.nodes[0].data.prompt).toBe('合成提示词');
  });

  it('选中、测量和运行进度复用内容，但节点编辑、边顺序与组变化仍判脏', () => {
    const source = canvas();
    const cache = new CanvasPersistence();
    const first = cache.capture(source);
    const runtime = {
      ...source,
      nodes: source.nodes.map((node) => ({
        ...node,
        selected: false,
        measured: { width: 999, height: 999 },
        data: { ...node.data, runProgress: 80 },
      })),
    };
    expect(cache.capture(runtime)).toBe(first);
    expect(first.matches(runtime)).toBe(true);
    for (const changed of [
      { ...source, nodes: source.nodes.slice(1) },
      { ...source, nodes: source.nodes.map((node) => ({ ...node, width: 400 })) },
      { ...source, nodes: source.nodes.map((node) => ({ ...node, position: { x: 2, y: 3 } })) },
      {
        ...source,
        nodes: source.nodes.map((node) => ({ ...node, data: { ...node.data, enabled: false } })),
      },
      { ...source, edges: [...source.edges].reverse() },
      { ...source, groups: source.groups.map((group) => ({ ...group, name: '新组名' })) },
      { ...source, groups: source.groups.map((group) => ({ ...group, nodeIds: ['a'] })) },
    ]) {
      expect(sameCanvasContent(source, changed)).toBe(false);
    }
  });
});

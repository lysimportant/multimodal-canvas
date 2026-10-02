import { describe, expect, it, vi } from 'vitest';
import { CanvasHistory } from './canvas-history';
import { CanvasPersistence, type CanvasSnapshot } from './canvas-persistence';
import { toCanvasDocument } from './canvas-utils';

/** 只生成合成文本、坐标及链式连线，不读取真实项目或访问服务。 */
function fixture(count: number): CanvasSnapshot {
  return {
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `n${index}`,
      type: 'text',
      position: { x: index * 250, y: 0 },
      width: 230,
      height: 216,
      data: {
        label: `节点${index}`,
        mediaType: 'text',
        mode: 'generate',
        prompt: 'synthetic prompt '.repeat(64),
      },
    })),
    edges: Array.from({ length: count - 1 }, (_, index) => ({
      id: `e${index}`,
      source: `n${index}`,
      target: `n${index + 1}`,
    })),
    groups: [],
  };
}

/** 每次只移动一个节点，匹配普通拖动在起始位置记历史的调用方式。 */
function move(current: CanvasSnapshot, index: number): CanvasSnapshot {
  return {
    ...current,
    nodes: current.nodes.map((node, i) =>
      i === index % current.nodes.length
        ? { ...node, position: { ...node.position, x: node.position.x + 1 } }
        : node,
    ),
  };
}

/** 用固定 50 次编辑对照原路径；时间只输出观测值，不作为易抖动的 CI 阈值。 */
describe('合成大画布历史/保存工作量基准', () => {
  it.each([100, 300, 1000])('%i 节点：共享对象，取消整图克隆及历史/保存 JSON 比较', (count) => {
    const measurements = [];
    for (const mode of ['before', 'after'] as const) {
      for (let sample = 0; sample < 3; sample++) {
        let current = fixture(count);
        let past: CanvasSnapshot[] = [];
        const history = new CanvasHistory();
        const persistence = new CanvasPersistence();
        const clone = vi.spyOn(globalThis, 'structuredClone');
        const encode = vi.spyOn(JSON, 'stringify');
        const start = performance.now();
        for (let edit = 0; edit < 50; edit++) {
          if (mode === 'before') {
            const snapshot = {
              nodes: structuredClone(current.nodes),
              edges: structuredClone(current.edges),
              groups: structuredClone(current.groups),
            };
            const previous = past.at(-1);
            if (!previous || JSON.stringify(previous) !== JSON.stringify(snapshot))
              past = [...past.slice(-49), snapshot];
          } else {
            history.remember(current);
          }
          current = move(current, edit);
        }
        const historyMs = performance.now() - start;
        const saveStart = performance.now();
        if (mode === 'before') {
          const nodes = structuredClone(current.nodes);
          const edges = structuredClone(current.edges);
          const groups = structuredClone(current.groups);
          const snapshot = JSON.stringify({ nodes, edges, groups });
          JSON.stringify(toCanvasDocument(nodes, edges, 1, groups));
          expect(JSON.stringify(current)).toBe(snapshot);
          JSON.stringify(toCanvasDocument(current.nodes, current.edges, 2, current.groups));
        } else {
          const snapshot = persistence.capture(current);
          snapshot.serialize(1);
          expect(snapshot.matches(current)).toBe(true);
          persistence.capture(current).serialize(2);
        }
        const saveAndDraftMs = performance.now() - saveStart;
        const clones = clone.mock.calls.length;
        const graphEncodes = encode.mock.calls.filter(
          ([value]) => typeof value === 'object',
        ).length;
        const retainedNodes = new Set(
          (mode === 'before' ? past : history.past).flatMap((snapshot) => snapshot.nodes),
        ).size;
        measurements.push({
          mode,
          sample,
          historyMs: +historyMs.toFixed(2),
          saveAndDraftMs: +saveAndDraftMs.toFixed(2),
          clones,
          graphEncodes,
          retainedNodes,
        });
        expect(clones).toBe(mode === 'before' ? 153 : 0);
        expect(graphEncodes).toBe(mode === 'before' ? 102 : 1);
        expect(retainedNodes).toBe(mode === 'before' ? count * 50 : count + 49);
        clone.mockRestore();
        encode.mockRestore();
      }
    }
    console.info(JSON.stringify({ nodes: count, edits: 50, measurements }));
  });
});

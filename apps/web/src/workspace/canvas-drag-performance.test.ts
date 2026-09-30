import { describe, expect, it } from 'vitest';
import type { GenerationBatchView } from './generation-batch-view';
import { reuseGenerationBatchViews } from './canvas-drag-performance';

/** 不含几何坐标的批次状态；位置变化不能改变这些节点交互语义。 */
const collapsed: GenerationBatchView = {
  rootNodeId: 'root',
  count: 3,
  expanded: false,
  hidden: true,
};

describe('reuseGenerationBatchViews', () => {
  it('普通节点和等值批次投影复用旧映射，不依赖成员遍历顺序', () => {
    const empty = new Map<string, GenerationBatchView>();
    expect(reuseGenerationBatchViews(empty, new Map())).toBe(empty);
    const previous = new Map([
      ['a', collapsed],
      ['b', { ...collapsed }],
    ]);
    const next = new Map([
      ['b', { ...collapsed }],
      ['a', { ...collapsed }],
    ]);
    expect(reuseGenerationBatchViews(previous, next)).toBe(previous);
    expect([...previous.keys()]).toEqual(['a', 'b']);
    expect([...next.keys()]).toEqual(['b', 'a']);
  });

  it.each<Partial<GenerationBatchView>>([
    { rootNodeId: 'new-root' },
    { count: 2 },
    { expanded: true },
    { hidden: false },
  ])('交互字段变化 %j 时发布新状态', (change) => {
    const previous = new Map([['a', collapsed]]);
    const next = new Map([['a', { ...collapsed, ...change }]]);
    expect(reuseGenerationBatchViews(previous, next)).toBe(next);
    expect(previous.get('a')).toBe(collapsed);
  });

  it('新增、删除或等量替换成员都不沿用旧状态', () => {
    const previous = new Map([['a', collapsed]]);
    for (const next of [
      new Map<string, GenerationBatchView>(),
      new Map([['b', collapsed]]),
      new Map([
        ['a', collapsed],
        ['b', collapsed],
      ]),
    ]) {
      expect(reuseGenerationBatchViews(previous, next)).toBe(next);
    }
  });
});

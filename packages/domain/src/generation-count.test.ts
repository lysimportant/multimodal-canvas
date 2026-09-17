import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GENERATION_COUNT,
  GENERATION_COUNT_MAX,
  getNodeGenerationCount,
  isValidGenerationCount,
  nodeDataSchema,
} from './index';

/** 只包含生成数量边界相关字段的合成节点。 */
const node = { label: '批量生成', mediaType: 'image', mode: 'generate' } as const;

describe('节点生成数量', () => {
  it('历史节点保持缺省字段并只生成一份', () => {
    const data = nodeDataSchema.parse(node);
    expect(data).not.toHaveProperty('generationCount');
    expect(getNodeGenerationCount(data)).toBe(DEFAULT_GENERATION_COUNT);
  });

  it.each([1, 2, 3, GENERATION_COUNT_MAX])('保存整数数量 %s，且不进入媒体参数', (count) => {
    const data = nodeDataSchema.parse({ ...node, generationCount: count });
    expect(getNodeGenerationCount(data)).toBe(count);
    expect(data).not.toHaveProperty('parameters');
  });

  it.each([0, -1, 1.5, GENERATION_COUNT_MAX + 1, Infinity, NaN, '3', null])(
    '拒绝非法数量 %s，不静默截断成有效任务',
    (count) => {
      expect(isValidGenerationCount(count)).toBe(false);
      expect(nodeDataSchema.safeParse({ ...node, generationCount: count }).success).toBe(false);
      expect(() => getNodeGenerationCount({ generationCount: count })).toThrow(RangeError);
    },
  );

  it('旧节点不附加批量展示状态，批次节点保留分组与展开状态', () => {
    const legacy = nodeDataSchema.parse(node);
    expect(legacy).not.toHaveProperty('generationBatch');
    expect(legacy).not.toHaveProperty('generationBatchExpanded');
    const generationBatch = { id: 'batch-1', rootNodeId: 'node-1', index: 0 };
    const data = nodeDataSchema.parse({
      ...node,
      generationBatch,
      generationBatchExpanded: true,
    });
    expect(data.generationBatch).toEqual(generationBatch);
    expect(data.generationBatchExpanded).toBe(true);
    expect(getNodeGenerationCount(data)).toBe(1);
    expect(data).not.toHaveProperty('parameters');
  });

  it.each([
    { id: '', rootNodeId: 'node-1', index: 0 },
    { id: 'batch-1', rootNodeId: '', index: 0 },
    { id: 'batch-1', rootNodeId: 'node-1', index: -1 },
    { id: 'batch-1', rootNodeId: 'node-1', index: 0.5 },
  ])('拒绝非法批量展示字段 %j', (generationBatch) => {
    expect(nodeDataSchema.safeParse({ ...node, generationBatch }).success).toBe(false);
  });
});

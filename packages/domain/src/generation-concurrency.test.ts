import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENERATION_CONCURRENCY,
  generationConcurrencySchema,
  updateGenerationConcurrencySchema,
} from './generation-concurrency';

describe('全局生成并发合同', () => {
  it('默认 20，但允许大于 20 的正安全整数', () => {
    expect(DEFAULT_GENERATION_CONCURRENCY).toBe(20);
    for (const value of [1, 20, 21, 64, Number.MAX_SAFE_INTEGER]) {
      expect(generationConcurrencySchema.parse(value)).toBe(value);
    }
  });
  it.each([
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '20',
    '',
    null,
    undefined,
    true,
  ])('拒绝非法值 %s', (value) => {
    expect(generationConcurrencySchema.safeParse(value).success).toBe(false);
  });
  it('更新体拒绝额外作用域、用户及调度字段', () => {
    expect(
      updateGenerationConcurrencySchema.safeParse({ concurrency: 20, scope: 'project' }).success,
    ).toBe(false);
    expect(updateGenerationConcurrencySchema.safeParse({}).success).toBe(false);
  });
});

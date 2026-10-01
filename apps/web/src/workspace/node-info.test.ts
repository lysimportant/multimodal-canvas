import { describe, expect, it } from 'vitest';

import { getNodeInfoTimes } from './node-info';

/** 固定时间只用于校验真实记录的展示，不依赖测试机器当前时间或时区。 */
const recordedAt = '2026-09-16T10:00:12.400Z';

/** 当前展示结果的成功记录，与后续运行和供应商响应时间独立。 */
const resultData = {
  resultAsset: { assetId: 'result-image', version: 1 },
  resultTiming: {
    nodeId: 'node-1',
    requestFinishedAt: '2026-09-16T10:00:10.000Z',
    finishedAt: recordedAt,
    outcome: 'succeeded' as const,
  },
};

describe('getNodeInfoTimes', () => {
  it('保留创建时间，并按当前结果的服务端完成时间展示而不是供应商响应时间', () => {
    const times = getNodeInfoTimes('node-1', {
      ...resultData,
      createdAt: '2026-09-16T17:00:00+08:00',
    });
    expect(times.createdAt?.dateTime).toBe('2026-09-16T09:00:00.000Z');
    expect(times.resultAt).toEqual({
      dateTime: recordedAt,
      label: new Date(recordedAt).toLocaleString('zh-CN', { hour12: false }),
    });
  });

  it('历史记录缺失时不使用当前时间或其他生命周期字段补齐', () => {
    expect(getNodeInfoTimes('node-1', {})).toEqual({ createdAt: undefined, resultAt: undefined });
    const data = {
      assetId: 'old-image',
      contentUrl: '/v1/assets/old-image/content',
      updatedAt: recordedAt,
      nodeTiming: resultData.resultTiming,
      resultTiming: {
        nodeId: 'node-1',
        queuedAt: recordedAt,
        startedAt: recordedAt,
        requestFinishedAt: recordedAt,
        outcome: 'succeeded' as const,
      },
    };
    expect(getNodeInfoTimes('node-1', data)).toEqual({ createdAt: undefined, resultAt: undefined });
  });

  it.each(['', 'not-a-date', '2026-09-16', '2026-09-16T10:00:00', '2026-02-30T10:00:00Z'])(
    '拒绝缺失时区、残缺或无效时间 %s',
    (value) => {
      expect(
        getNodeInfoTimes('node-1', {
          ...resultData,
          createdAt: value,
          resultTiming: { ...resultData.resultTiming, finishedAt: value },
        }),
      ).toEqual({ createdAt: undefined, resultAt: undefined });
    },
  );

  it.each(['failed', 'cancelled', undefined] as const)(
    '非成功终态 %s 不作为结果回显时间',
    (outcome) => {
      expect(
        getNodeInfoTimes('node-1', {
          ...resultData,
          resultTiming: { ...resultData.resultTiming, outcome },
        }).resultAt,
      ).toBeUndefined();
    },
  );

  it('手动替换、无结果和其他节点的执行时间都不继承旧回显时间', () => {
    expect(
      getNodeInfoTimes('node-1', { ...resultData, manualOutput: true }).resultAt,
    ).toBeUndefined();
    expect(
      getNodeInfoTimes('node-1', { resultTiming: resultData.resultTiming }).resultAt,
    ).toBeUndefined();
    expect(getNodeInfoTimes('other-node', resultData).resultAt).toBeUndefined();
  });

  it('恢复的旧结果可以复用其已关联的成功时间，但不能回填节点创建时间', () => {
    const times = getNodeInfoTimes('node-1', {
      assetId: 'old-image',
      contentUrl: '/v1/assets/old-image/content',
      resultTiming: resultData.resultTiming,
    });
    expect(times.createdAt).toBeUndefined();
    expect(times.resultAt?.dateTime).toBe(recordedAt);
  });
});

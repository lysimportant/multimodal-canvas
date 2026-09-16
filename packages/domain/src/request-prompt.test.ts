import { describe, expect, it } from 'vitest';

import {
  canvasDocumentSchema,
  formatNodeDuration,
  nodeTimingDuration,
  renderRequestPromptText,
  requestPromptRecordKey,
  requestPromptRecordSchema,
  REQUEST_PROMPT_SCHEMA_VERSION,
  type RequestPromptRecord,
} from './index';

/** 构造一份各字段齐备的图片请求记录，测试只覆盖被断言的字段。 */
function record(overrides: Partial<RequestPromptRecord> = {}): RequestPromptRecord {
  return {
    schemaVersion: REQUEST_PROMPT_SCHEMA_VERSION,
    runId: 'run-1',
    nodeId: 'node-1',
    attempt: 1,
    requestIdentity: 'POST /images/generations#1',
    provider: 'newapi',
    modelAlias: 'grok-image-1',
    mediaType: 'image',
    format: 'plain',
    parts: [{ order: 0, text: '月白布衫，青裙' }],
    resources: [],
    sendStatus: 'sent',
    createdAt: '2026-09-16T10:00:00.000Z',
    ...overrides,
  };
}

describe('request prompt record contract', () => {
  it('接受图片、音频与视频的纯文本请求，并保留最终发送字符串', () => {
    for (const mediaType of ['image', 'audio', 'video'] as const) {
      const parsed = requestPromptRecordSchema.safeParse(
        record({ mediaType, negativeText: '模糊' }),
      );
      expect(parsed.success).toBe(true);
      expect(renderRequestPromptText(parsed.data!)).toBe('月白布衫，青裙');
    }
  });

  it('文字多消息结果按实际顺序渲染角色与 name 分隔', () => {
    const parsed = requestPromptRecordSchema.parse(
      record({
        mediaType: 'text',
        format: 'messages',
        parts: [
          { order: 1, role: 'user', name: '参考图说明', text: '保持配色' },
          { order: 0, role: 'user', text: '写一段开头' },
        ],
      }),
    );
    expect(renderRequestPromptText(parsed)).toBe('[user] 写一段开头\n[user:参考图说明] 保持配色');
  });

  it('纯文本格式不拼接角色标签，空角色不产生前缀', () => {
    const parsed = requestPromptRecordSchema.parse(
      record({ format: 'messages', parts: [{ order: 0, text: '只有文本' }] }),
    );
    expect(renderRequestPromptText(parsed)).toBe('只有文本');
  });

  it('记录身份包含 runId、nodeId、attempt 与请求身份，避免上游结果被附错提示词', () => {
    const separator = String.fromCharCode(0);
    const key = requestPromptRecordKey(record({ nodeId: 'node-2', attempt: 3 }));
    expect(key.split(separator)).toEqual(['run-1', 'node-2', '3', 'POST /images/generations#1']);
    expect(key).not.toBe(requestPromptRecordKey(record()));
  });

  it('拒绝缺失发送状态或使用未知 schema 版本的记录', () => {
    const missingStatus = { ...record() } as Record<string, unknown>;
    delete missingStatus.sendStatus;
    expect(requestPromptRecordSchema.safeParse(missingStatus).success).toBe(false);
    expect(requestPromptRecordSchema.safeParse(record({ schemaVersion: 0 })).success).toBe(false);
  });

  it('参考资源只保存身份与顺序，不包含媒体二进制字段', () => {
    const parsed = requestPromptRecordSchema.parse(
      record({
        resources: [
          {
            assetId: 'asset-1',
            assetVersion: 2,
            role: 'imageEdit',
            sortOrder: 0,
            mediaType: 'image',
          },
        ],
      }),
    );
    expect(parsed.resources[0]).toEqual({
      assetId: 'asset-1',
      assetVersion: 2,
      role: 'imageEdit',
      sortOrder: 0,
      mediaType: 'image',
    });
    expect(JSON.stringify(parsed)).not.toMatch(/base64|data:image/);
  });
});

describe('node timing contract', () => {
  it('终态耗时使用 finishedAt - startedAt', () => {
    expect(
      nodeTimingDuration(
        {
          nodeId: 'node-1',
          startedAt: '2026-09-16T10:00:00.000Z',
          finishedAt: '2026-09-16T10:00:12.400Z',
        },
        Date.parse('2026-09-16T10:05:00.000Z'),
      ),
    ).toEqual({ availability: 'recorded', milliseconds: 12_400 });
  });

  it('运行中按服务端已记录的开始时间返回递增基准', () => {
    expect(
      nodeTimingDuration(
        { nodeId: 'node-1', startedAt: '2026-09-16T10:00:00.000Z' },
        Date.parse('2026-09-16T10:00:03.000Z'),
      ),
    ).toEqual({ availability: 'running', milliseconds: 3_000, since: 'startedAt' });
  });

  it('缺少时间戳时不显示 0 秒或推测值', () => {
    expect(nodeTimingDuration({ nodeId: 'node-1' }, Date.now())).toEqual({
      availability: 'unrecorded',
    });
    expect(
      nodeTimingDuration({ nodeId: 'node-1', finishedAt: '2026-09-16T10:00:00.000Z' }, Date.now()),
    ).toEqual({ availability: 'unrecorded' });
  });

  it('时间顺序异常与未来时间显式标记不可用，绝不返回负数', () => {
    const outOfOrder = nodeTimingDuration(
      {
        nodeId: 'node-1',
        startedAt: '2026-09-16T10:00:10.000Z',
        finishedAt: '2026-09-16T10:00:00.000Z',
      },
      Date.now(),
    );
    expect(outOfOrder).toEqual({ availability: 'invalid', reason: 'out-of-order' });
    expect(
      nodeTimingDuration(
        { nodeId: 'node-1', startedAt: '2026-09-16T10:00:10.000Z' },
        Date.parse('2026-09-16T10:00:00.000Z'),
      ),
    ).toEqual({ availability: 'invalid', reason: 'future' });
  });

  it('短耗时与长耗时使用不同格式，非法输入不产生文本', () => {
    expect(formatNodeDuration(12_400)).toBe('12.4 s');
    expect(formatNodeDuration(999)).toBe('1.0 s');
    expect(formatNodeDuration(128_000)).toBe('2 分 08 秒');
    expect(formatNodeDuration(120_000)).toBe('2 分');
    expect(formatNodeDuration(-1)).toBe('');
    expect(formatNodeDuration(Number.NaN)).toBe('');
  });
});

describe('canvas group contract', () => {
  const baseDocument = {
    revision: 1,
    nodes: [
      {
        id: 'a',
        type: 'image',
        position: { x: 0, y: 0 },
        data: { label: 'A', mediaType: 'image', mode: 'generate' },
      },
    ],
    edges: [],
  };

  it('旧画布缺少 groups 字段时按空组列表读取', () => {
    const parsed = canvasDocumentSchema.safeParse(baseDocument);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.groups).toBeUndefined();
  });

  it('接受合法组并保留成员顺序', () => {
    const parsed = canvasDocumentSchema.safeParse({
      ...baseDocument,
      groups: [
        {
          id: 'g1',
          name: '场景',
          position: { x: -20, y: -40 },
          width: 640,
          height: 420,
          nodeIds: ['a'],
        },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data!.groups?.[0]?.nodeIds).toEqual(['a']);
  });

  it('拒绝重复组 ID、缺失成员与重复归属', () => {
    const group = { id: 'g1', name: 'G', position: { x: 0, y: 0 }, width: 200, height: 200 };
    expect(
      canvasDocumentSchema.safeParse({
        ...baseDocument,
        groups: [group, { ...group, name: 'H' }],
      }).success,
    ).toBe(false);
    expect(
      canvasDocumentSchema.safeParse({
        ...baseDocument,
        groups: [{ ...group, nodeIds: ['ghost'] }],
      }).success,
    ).toBe(false);
    expect(
      canvasDocumentSchema.safeParse({
        ...baseDocument,
        groups: [{ ...group, nodeIds: ['a', 'a'] }],
      }).success,
    ).toBe(false);
    expect(
      canvasDocumentSchema.safeParse({
        ...baseDocument,
        groups: [group, { ...group, id: 'g2', nodeIds: ['a'] }],
      }).success,
    ).toBe(false);
  });

  it('拒绝非正尺寸、超上限尺寸与非有限坐标', () => {
    const group = { id: 'g1', name: 'G', position: { x: 0, y: 0 }, width: 200, height: 200 };
    for (const candidate of [
      { ...group, width: 0 },
      { ...group, width: -10 },
      { ...group, height: 0 },
      { ...group, width: 20_000 },
      { ...group, position: { x: Number.POSITIVE_INFINITY, y: 0 } },
      { ...group, position: { x: 0, y: Number.NaN } },
    ]) {
      expect(canvasDocumentSchema.safeParse({ ...baseDocument, groups: [candidate] }).success).toBe(
        false,
      );
    }
  });

  it('组不参与端口与环校验：组内成员仍按原图结构校验', () => {
    const parsed = canvasDocumentSchema.safeParse({
      ...baseDocument,
      nodes: [
        ...baseDocument.nodes,
        {
          id: 'b',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'B', mediaType: 'text', mode: 'generate' },
        },
      ],
      groups: [
        {
          id: 'g1',
          name: 'G',
          position: { x: 0, y: 0 },
          width: 400,
          height: 400,
          nodeIds: ['a', 'b'],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

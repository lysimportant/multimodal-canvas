import { describe, expect, it } from 'vitest';

import { canvasDocumentSchema, nodeDataSchema } from './index';

/** 模拟新建节点时记录的 UTC 时间，不从资源或运行记录推断。 */
const createdAt = '2026-10-01T08:00:00.000Z';

describe('节点创建时间协议', () => {
  it.each(['source', 'generate'] as const)('%s 节点创建时间通过画布 schema 保存', (mode) => {
    const document = canvasDocumentSchema.parse({
      revision: 1,
      nodes: [
        {
          id: 'node-1',
          type: 'image',
          position: { x: 0, y: 0 },
          data: { label: '图片节点', mediaType: 'image', mode, createdAt },
        },
      ],
      edges: [],
    });
    expect(document.nodes[0].data.createdAt).toBe(createdAt);
    expect(
      canvasDocumentSchema.parse(JSON.parse(JSON.stringify(document))).nodes[0].data.createdAt,
    ).toBe(createdAt);
  });

  it('旧节点缺少创建时间时仍兼容，解析不会生成时间', () => {
    const data = { label: '旧节点', mediaType: 'image', mode: 'generate' };
    expect(nodeDataSchema.parse(data)).not.toHaveProperty('createdAt');
  });

  it.each(['', 'not-a-date', '2026-10-01', '2026-10-01T08:00:00', '2026-02-30T08:00:00Z'])(
    '拒绝无效或缺少时区的节点时间 %s',
    (value) => {
      expect(
        nodeDataSchema.safeParse({
          label: '图片节点',
          mediaType: 'image',
          mode: 'generate',
          createdAt: value,
        }).success,
      ).toBe(false);
    },
  );
});

import { describe, expect, it } from 'vitest';

import { getEffectivePromptDocument, type CanvasDocument, type CanvasNode } from './index.js';
import {
  applyCanvasOperations,
  CanvasOperationError,
  canvasOperationsSchema,
  type CanvasOperations,
} from './canvas-operations.js';

const sourceNode: CanvasNode = {
  id: 'source',
  type: 'image',
  position: { x: 0, y: 0 },
  data: { label: '参考图', mediaType: 'image', mode: 'source', assetId: 'asset-reference' },
};
const generatedNode: CanvasNode = {
  id: 'target',
  type: 'image',
  position: { x: 300, y: 0 },
  width: 320,
  height: 240,
  data: {
    label: '生成节点',
    mediaType: 'image',
    mode: 'generate',
    prompt: '已有正文',
    promptDocument: { version: 1, blocks: [{ type: 'text', text: '已有结构化正文' }] },
    resourceRefs: [
      {
        id: 'reference',
        assetId: 'asset-reference',
        mediaType: 'image',
        name: '参考图',
        attached: true,
      },
    ],
    parameters: { quality: 'high', seed: 7 },
    modelAlias: 'image-model',
    credentialId: 'credential-reference',
    generationCount: 3,
    manualOutput: true,
    assetId: 'existing-output',
  },
};

function document(): CanvasDocument {
  return structuredClone({
    revision: 4,
    nodes: [sourceNode, generatedNode],
    edges: [],
    groups: [
      {
        id: 'group',
        name: '现有分组',
        position: { x: 0, y: 0 },
        width: 800,
        height: 400,
        nodeIds: ['source', 'target'],
      },
    ],
  });
}

const edge = {
  id: 'reference-edge',
  sourceNodeId: 'source',
  sourceHandle: 'output:image',
  targetNodeId: 'target',
  targetHandle: 'input:referenceImage',
  order: 0,
};

/** 非法 JSON 仍通过入口运行时校验，不能依赖 TypeScript 限制调用者。 */
function expectInvalid(input: unknown, canvas = document()) {
  const original = structuredClone(canvas);
  expect(() => applyCanvasOperations(canvas, input as CanvasOperations)).toThrowError(
    expect.objectContaining({ name: 'CanvasOperationError', code: 'invalid_operation' }),
  );
  expect(canvas).toEqual(original);
}

describe('原子画布操作合同', () => {
  it('顺序新建、修改、移动和连线，保留版本、分组与既有节点内容', () => {
    const canvas = document();
    const original = structuredClone(canvas);
    const batch: CanvasOperations = {
      revision: 4,
      operations: [
        { type: 'create_node', node: { ...sourceNode, id: 'new-source' }, assetVersion: 2 },
        {
          type: 'update_node',
          nodeId: 'target',
          data: { label: '更新名称', parameters: { size: '1024x1024' }, enabled: false },
        },
        { type: 'move_node', nodeId: 'new-source', position: { x: -25, y: 52.5 } },
        { type: 'connect_nodes', edge: { ...edge, sourceNodeId: 'new-source' } },
      ],
    };
    const originalBatch = structuredClone(batch);
    const next = applyCanvasOperations(canvas, batch);

    expect(next).not.toBe(canvas);
    expect(next.revision).toBe(4);
    expect(next.groups).toEqual(original.groups);
    expect(next.nodes[0]).toEqual(original.nodes[0]);
    expect(next.nodes[1]).toEqual({
      ...generatedNode,
      data: {
        ...generatedNode.data,
        label: '更新名称',
        parameters: { size: '1024x1024' },
        enabled: false,
      },
    });
    expect(next.nodes[2]).toEqual({
      ...sourceNode,
      id: 'new-source',
      position: { x: -25, y: 52.5 },
      // 新建节点未给尺寸时按媒体默认值补齐卡片尺寸（图片 400×266），不再落成 230×216。
      width: 400,
      height: 266,
      data: {
        ...sourceNode.data,
        contentUrl: '/v1/assets/asset-reference/versions/2/content',
      },
    });
    expect(next.edges).toEqual([{ ...edge, sourceNodeId: 'new-source' }]);
    expect(canvas).toEqual(original);
    expect(batch).toEqual(originalBatch);
  });

  it('纯文本更新清除旧结构化正文，保留绑定资源与其它数据', () => {
    const next = applyCanvasOperations(document(), {
      revision: 4,
      operations: [{ type: 'update_node', nodeId: 'target', data: { prompt: ' 新正文 ' } }],
    });
    const data = next.nodes[1]!.data;
    expect(data.prompt).toBe('新正文');
    expect(data).not.toHaveProperty('promptDocument');
    expect(getEffectivePromptDocument(data).blocks).toEqual([{ type: 'text', text: '新正文' }]);
    expect(data.resourceRefs).toEqual(generatedNode.data.resourceRefs);
    expect(data.parameters).toEqual(generatedNode.data.parameters);
    expect(data.manualOutput).toBe(true);
    expect(data.assetId).toBe('existing-output');
  });

  it('来源素材冻结指定版本，特殊资产 ID 编码为规范内容地址', () => {
    const canvas = document();
    const batch: CanvasOperations = {
      revision: 4,
      operations: [
        {
          type: 'create_node',
          assetVersion: 3,
          node: {
            ...sourceNode,
            id: 'versioned-source',
            data: { ...sourceNode.data, assetId: '图片 /?#%' },
          },
        },
      ],
    };
    const next = applyCanvasOperations(canvas, batch);
    expect(next.nodes.at(-1)!.data).toEqual({
      ...sourceNode.data,
      assetId: '图片 /?#%',
      contentUrl: '/v1/assets/%E5%9B%BE%E7%89%87%20%2F%3F%23%25/versions/3/content',
    });
    expect(next.revision).toBe(4);
    expect(canvas.nodes).toHaveLength(2);
    expect(batch.operations[0]).not.toHaveProperty('node.data.contentUrl');
  });

  it.each([undefined, 0, -1, 1.5, '2', null])('已有素材拒绝缺失或无效版本 %s', (assetVersion) => {
    expectInvalid({
      revision: 4,
      operations: [{ type: 'create_node', node: { ...sourceNode, id: 'new' }, assetVersion }],
    });
  });

  it('没有素材 ID 时禁止声明版本；普通新建节点无需素材版本', () => {
    const node = {
      id: 'empty',
      type: 'image' as const,
      position: { x: 0, y: 0 },
      data: { label: '空节点', mediaType: 'image' as const, mode: 'generate' as const },
    };
    expectInvalid({ revision: 4, operations: [{ type: 'create_node', node, assetVersion: 2 }] });
    const next = applyCanvasOperations(document(), {
      revision: 4,
      operations: [{ type: 'create_node', node }],
    });
    expect(next.nodes.at(-1)).toEqual({ ...node, width: 400, height: 266 });
    expect(next.nodes.at(-1)!.data).not.toHaveProperty('contentUrl');
  });

  it('新建节点按创作参数比例推导长方形卡片，显式尺寸优先', () => {
    const videoNode = {
      id: 'portrait-video',
      type: 'video' as const,
      position: { x: 0, y: 0 },
      data: {
        label: '竖屏视频',
        mediaType: 'video' as const,
        mode: 'generate' as const,
        parameters: { aspectRatio: '9:16', duration: 30 },
      },
    };
    const next = applyCanvasOperations(document(), {
      revision: 4,
      operations: [
        { type: 'create_node', node: videoNode },
        {
          type: 'create_node',
          node: { ...videoNode, id: 'fixed-size-video', width: 300, height: 400 },
        },
      ],
    });
    expect(next.nodes.find((node) => node.id === 'portrait-video')).toEqual({
      ...videoNode,
      width: 236,
      height: 420,
    });
    expect(next.nodes.find((node) => node.id === 'fixed-size-video')).toEqual({
      ...videoNode,
      id: 'fixed-size-video',
      width: 300,
      height: 400,
    });
  });

  it('不可编码的素材身份返回合同错误，不能在生成版本 URL 时抛出 URI 异常', () => {
    expectInvalid({
      revision: 4,
      operations: [
        {
          type: 'create_node',
          node: { ...sourceNode, id: 'new', data: { ...sourceNode.data, assetId: '\uD800' } },
          assetVersion: 1,
        },
      ],
    });
  });

  it('批次接受 100 个操作，拒绝 101 个且不写入任何局部修改', () => {
    const operations = Array.from({ length: 100 }, (_, index) => ({
      type: 'move_node' as const,
      nodeId: 'target',
      position: { x: index, y: index },
    }));
    const next = applyCanvasOperations(document(), { revision: 4, operations });
    expect(next.nodes[1]!.position).toEqual({ x: 99, y: 99 });
    expectInvalid({ revision: 4, operations: [...operations, operations[0]] });
  });

  it('显式结构化正文与冻结素材提及继续优先，参数和模型配置可更新', () => {
    const promptDocument = {
      version: 1 as const,
      blocks: [
        { type: 'text' as const, text: '根据参考图生成：' },
        {
          type: 'mention' as const,
          mentionId: 'mention',
          assetId: 'asset-reference',
          assetVersion: 2,
          mediaType: 'image' as const,
          label: '参考图',
        },
      ],
    };
    const next = applyCanvasOperations(document(), {
      revision: 4,
      operations: [
        {
          type: 'update_node',
          nodeId: 'target',
          data: {
            prompt: '兼容正文',
            promptDocument,
            modelAlias: 'updated-model',
            credentialId: 'updated-reference',
            inferenceStrength: 'high',
            imageEditSource: { sourceNodeId: 'source', assetId: 'asset-reference', version: 2 },
          },
        },
      ],
    });
    expect(getEffectivePromptDocument(next.nodes[1]!.data)).toEqual(promptDocument);
    expect(next.nodes[1]!.data).toMatchObject({
      modelAlias: 'updated-model',
      credentialId: 'updated-reference',
      inferenceStrength: 'high',
      imageEditSource: { sourceNodeId: 'source', assetId: 'asset-reference', version: 2 },
    });
  });

  it('旧版本拒绝并返回当前版本，任何已开始的局部操作不会写入输入', () => {
    const canvas = document();
    const original = structuredClone(canvas);
    expect(() =>
      applyCanvasOperations(canvas, {
        revision: 3,
        operations: [{ type: 'move_node', nodeId: 'target', position: { x: 1, y: 2 } }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'revision_conflict', revision: 4 }));
    expect(canvas).toEqual(original);
  });

  it.each([
    { type: 'create_node', node: sourceNode, assetVersion: 2 },
    { type: 'move_node', nodeId: 'missing', position: { x: 1, y: 2 } },
    { type: 'update_node', nodeId: 'missing', data: { prompt: '新正文' } },
    { type: 'connect_nodes', edge: { ...edge, sourceNodeId: 'missing' } },
    { type: 'connect_nodes', edge: { ...edge, sourceHandle: 'output:audio' } },
    { type: 'connect_nodes', edge: { ...edge, targetHandle: 'input:missing' } },
    { type: 'connect_nodes', edge: { ...edge, targetNodeId: 'source' } },
  ])('无效操作不会提交前序合法更新：$type', (operation) => {
    expectInvalid({
      revision: 4,
      operations: [
        { type: 'update_node', nodeId: 'target', data: { label: '不可部分生效' } },
        operation,
      ],
    });
  });

  it('拒绝同批次重复节点 ID 和被其它连线占用的 ID', () => {
    expectInvalid({
      revision: 4,
      operations: [
        { type: 'create_node', node: { ...sourceNode, id: 'new' }, assetVersion: 2 },
        { type: 'create_node', node: { ...sourceNode, id: 'new' }, assetVersion: 2 },
      ],
    });
    expectInvalid({
      revision: 4,
      operations: [
        { type: 'connect_nodes', edge },
        { type: 'connect_nodes', edge: { ...edge, order: 1 } },
      ],
    });
  });

  it('重复连接同一输入幂等，重试生成不同 ID 也保留最初边的身份', () => {
    const canvas = document();
    const connected = applyCanvasOperations(canvas, {
      revision: 4,
      operations: [
        { type: 'connect_nodes', edge },
        { type: 'connect_nodes', edge },
        { type: 'connect_nodes', edge: { ...edge, id: 'retry-edge' } },
      ],
    });
    expect(connected.edges).toEqual([edge]);
    expect(canvas.edges).toEqual([]);
    expect(
      applyCanvasOperations(connected, {
        revision: 4,
        operations: [{ type: 'connect_nodes', edge: { ...edge, id: 'another-retry' } }],
      }).edges,
    ).toEqual([edge]);
  });

  it('不同顺序或输入用途不合并；已占用 ID 不能借语义重复绕过检查', () => {
    const alternateOrder = { ...edge, id: 'alternate-order', order: 1 };
    const alternateRole = { ...edge, id: 'alternate-role', targetHandle: 'input:content' };
    const connected = applyCanvasOperations(document(), {
      revision: 4,
      operations: [edge, alternateOrder, alternateRole].map((edge) => ({
        type: 'connect_nodes',
        edge,
      })),
    });
    expect(connected.edges).toEqual([edge, alternateOrder, alternateRole]);
    expectInvalid(
      {
        revision: 4,
        operations: [{ type: 'connect_nodes', edge: { ...edge, id: alternateOrder.id } }],
      },
      connected,
    );
  });

  it('精确断开一条边，保留其它用途、节点和原画布；缺失 ID 不静默忽略', () => {
    const canvas = document();
    const otherEdge = { ...edge, id: 'other-edge', order: 1 };
    canvas.edges = [edge, otherEdge];
    const next = applyCanvasOperations(canvas, {
      revision: 4,
      operations: [{ type: 'disconnect_edge', edgeId: edge.id }],
    });
    expect(next.edges).toEqual([otherEdge]);
    expect(next.nodes).toEqual(canvas.nodes);
    expect(canvas.edges).toEqual([edge, otherEdge]);
    expectInvalid(
      { revision: 4, operations: [{ type: 'disconnect_edge', edgeId: edge.id }] },
      next,
    );
  });

  it('原位替换来源并可保留或更换边 ID，断开的 ID 可在同批次复用', () => {
    const canvas = document();
    canvas.nodes.push({ ...sourceNode, id: 'new-source' });
    const otherEdge = { ...edge, id: 'other-edge', order: 1 };
    canvas.edges = [edge, otherEdge];
    const replacement = { ...edge, sourceNodeId: 'new-source' };
    const next = applyCanvasOperations(canvas, {
      revision: 4,
      operations: [{ type: 'replace_edge', edgeId: edge.id, edge: replacement }],
    });
    expect(next.edges).toEqual([replacement, otherEdge]);
    expect(canvas.edges).toEqual([edge, otherEdge]);
    expect(
      applyCanvasOperations(next, {
        revision: 4,
        operations: [
          { type: 'disconnect_edge', edgeId: otherEdge.id },
          { type: 'replace_edge', edgeId: edge.id, edge: { ...replacement, id: otherEdge.id } },
        ],
      }).edges,
    ).toEqual([{ ...replacement, id: otherEdge.id }]);
  });

  it.each([
    { type: 'disconnect_edge', edgeId: 'missing' },
    { type: 'replace_edge', edgeId: 'missing', edge },
    { type: 'replace_edge', edgeId: edge.id, edge: { ...edge, sourceNodeId: 'missing' } },
    { type: 'replace_edge', edgeId: edge.id, edge: { ...edge, targetHandle: 'input:missing' } },
    { type: 'replace_edge', edgeId: edge.id, edge: { ...edge, targetNodeId: 'source' } },
    { type: 'replace_edge', edgeId: edge.id, edge: { ...edge, id: 'other-edge' } },
    { type: 'replace_edge', edgeId: edge.id, edge: { ...edge, order: 1 } },
  ])('断开或替换无效时整批回滚：%j', (operation) => {
    const canvas = document();
    canvas.edges = [edge, { ...edge, id: 'other-edge', order: 1 }];
    expectInvalid(
      {
        revision: 4,
        operations: [
          { type: 'update_node', nodeId: 'target', data: { label: '不可部分生效' } },
          operation,
        ],
      },
      canvas,
    );
  });

  it('新连线操作仍拒绝过期 revision，不修改画布', () => {
    const canvas = document();
    canvas.edges = [edge];
    const original = structuredClone(canvas);
    for (const operation of [
      { type: 'disconnect_edge' as const, edgeId: edge.id },
      { type: 'replace_edge' as const, edgeId: edge.id, edge: { ...edge, order: 1 } },
    ]) {
      expect(() =>
        applyCanvasOperations(canvas, { revision: 3, operations: [operation] }),
      ).toThrowError(expect.objectContaining({ code: 'revision_conflict', revision: 4 }));
    }
    expect(canvas).toEqual(original);
  });

  it('复用 DAG 校验拒绝环，并保留既有视频模式端口兼容策略', () => {
    const video = (id: string): CanvasNode => ({
      id,
      type: 'video',
      position: { x: 0, y: 0 },
      data: { label: id, mediaType: 'video', mode: 'generate' },
    });
    const canvas = { revision: 4, nodes: [video('a'), video('b')], edges: [] };
    const connection = {
      id: 'ab',
      sourceNodeId: 'a',
      sourceHandle: 'output:video',
      targetNodeId: 'b',
      targetHandle: 'input:content',
      order: 0,
    };
    expectInvalid(
      {
        revision: 4,
        operations: [
          { type: 'connect_nodes', edge: connection },
          {
            type: 'connect_nodes',
            edge: { ...connection, id: 'ba', sourceNodeId: 'b', targetNodeId: 'a' },
          },
        ],
      },
      canvas,
    );
    const connected = applyCanvasOperations(canvas, {
      revision: 4,
      operations: [{ type: 'connect_nodes', edge: connection }],
    });
    const updated = applyCanvasOperations(connected, {
      revision: 4,
      operations: [{ type: 'update_node', nodeId: 'b', data: { videoMode: 'text_to_video' } }],
    });
    expect(updated.edges).toEqual([connection]);
    expect(updated.nodes[1]!.data.videoMode).toBe('text_to_video');

    const chain = {
      revision: 4,
      nodes: [video('a'), video('b'), video('c')],
      edges: [connection, { ...connection, id: 'bc', sourceNodeId: 'b', targetNodeId: 'c' }],
    };
    expectInvalid(
      {
        revision: 4,
        operations: [
          {
            type: 'replace_edge',
            edgeId: 'bc',
            edge: { ...connection, id: 'bc', sourceNodeId: 'b', targetNodeId: 'a' },
          },
        ],
      },
      chain,
    );
  });

  it.each([
    null,
    {},
    { revision: -1, operations: [] },
    { revision: 4, operations: [] },
    { revision: 4, operations: [{ type: 'delete_node', nodeId: 'target' }] },
    { revision: 4, operations: [{ type: 'update_node', nodeId: 'target', data: {} }] },
    {
      revision: 4,
      operations: [
        { type: 'update_node', nodeId: 'target', data: { label: '新名称', prompt: undefined } },
      ],
    },
    {
      revision: 4,
      operations: [{ type: 'update_node', nodeId: 'target', data: { prompt: null } }],
    },
    {
      revision: 4,
      operations: [{ type: 'move_node', nodeId: 'target', position: { x: Infinity, y: 0 } }],
    },
  ])('拒绝无效批次结构 %#', (batch) => {
    expect(canvasOperationsSchema.safeParse(batch).success).toBe(false);
    expectInvalid(batch);
  });

  it.each([
    'assetId',
    'contentUrl',
    'manualOutput',
    'manualOutputRunId',
    'stale',
    'runStatus',
    'resultAsset',
  ])('更新不能伪造运行或来源字段 %s', (field) =>
    expectInvalid({
      revision: 4,
      operations: [{ type: 'update_node', nodeId: 'target', data: { [field]: 'forged' } }],
    }),
  );

  it.each([
    { ...sourceNode, data: { ...sourceNode.data, runStatus: 'succeeded' } },
    { ...sourceNode, data: { ...sourceNode.data, manualOutput: true } },
    { ...sourceNode, data: { ...sourceNode.data, contentUrl: '/forged-result' } },
    { ...sourceNode, data: { ...sourceNode.data, mediaType: 'video' } },
    { ...sourceNode, data: { ...sourceNode.data, mode: 'generate' } },
    { ...sourceNode, status: 'succeeded' },
  ])('创建不能伪造运行结果或错误媒体身份 %#', (node) => {
    expectInvalid({
      revision: 4,
      operations: [{ type: 'create_node', node: { ...node, id: 'new' }, assetVersion: 2 }],
    });
  });

  it('复用提示词提及唯一性和资源版本校验', () => {
    const mention = {
      type: 'mention',
      mentionId: 'duplicate',
      assetId: 'asset-reference',
      mediaType: 'image',
      label: '参考图',
    };
    expectInvalid({
      revision: 4,
      operations: [
        {
          type: 'update_node',
          nodeId: 'target',
          data: { promptDocument: { version: 1, blocks: [mention, mention] } },
        },
      ],
    });
    expectInvalid({
      revision: 4,
      operations: [
        {
          type: 'update_node',
          nodeId: 'target',
          data: {
            resourceRefs: [
              {
                id: 'ref',
                assetId: 'asset-reference',
                mediaType: 'image',
                name: '参考图',
                assetVersion: 0,
              },
            ],
          },
        },
      ],
    });
    expect(new CanvasOperationError('invalid_operation', 'invalid')).toBeInstanceOf(Error);
  });
});

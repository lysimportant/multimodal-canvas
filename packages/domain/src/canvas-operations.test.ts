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
    expect(next.nodes.at(-1)).toEqual(node);
    expect(next.nodes.at(-1)!.data).not.toHaveProperty('contentUrl');
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

  it('拒绝同批次重复节点或连线 ID', () => {
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
        { type: 'connect_nodes', edge },
      ],
    });
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

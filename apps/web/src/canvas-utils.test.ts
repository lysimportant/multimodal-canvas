import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';

import {
  fromCanvasDocument,
  markDownstreamNodesStale,
  copyCanvasSelection,
  parseCanvasClipboard,
  pasteCanvasClipboard,
  serializeCanvasClipboard,
  toCanvasDocument,
  withNodeAutoGrowthLimit,
  wouldCreateCycle,
  type AssetFlowNode,
  type FlowEdge,
} from './canvas-utils';

function flowNode(
  id: string,
  mediaType: 'text' | 'image' | 'audio' | 'video' = 'image',
  extraData: Record<string, unknown> = {},
): AssetFlowNode {
  return {
    id,
    type: mediaType,
    position: { x: 10, y: 20 },
    data: {
      label: id,
      mediaType,
      mode: 'generate',
      ...extraData,
    },
  } as AssetFlowNode;
}

function flowEdge(id: string, source: string, target: string, targetHandle?: string): FlowEdge {
  return {
    id,
    source,
    target,
    ...(targetHandle ? { targetHandle } : {}),
  };
}

describe('stale propagation', () => {
  it('marks all downstream nodes without clearing existing results', () => {
    const nodes = [
      flowNode('source'),
      flowNode('middle', 'text', { resultAsset: { assetId: 'asset-old' } }),
      flowNode('target', 'text'),
      flowNode('unrelated', 'text'),
    ];
    const edges = [flowEdge('e1', 'source', 'middle'), flowEdge('e2', 'middle', 'target')];

    const updated = markDownstreamNodesStale(nodes, edges, ['source']);

    expect(updated.find((node) => node.id === 'source')?.data.stale).toBeUndefined();
    expect(updated.find((node) => node.id === 'middle')?.data.stale).toBe(true);
    expect(updated.find((node) => node.id === 'middle')?.data.resultAsset).toEqual({
      assetId: 'asset-old',
    });
    expect(updated.find((node) => node.id === 'target')?.data.stale).toBe(true);
    expect(updated.find((node) => node.id === 'unrelated')?.data.stale).toBeUndefined();
  });
});

describe('canvas document conversion', () => {
  it('maps API edges and supplies a safe MIME type for nodes without one', () => {
    const document: CanvasDocument = {
      revision: 4,
      nodes: [
        {
          id: 'source',
          type: 'image',
          position: { x: 1, y: 2 },
          width: 280,
          height: 190,
          data: { label: 'Source', mediaType: 'image', mode: 'source' },
        },
        {
          id: 'target',
          type: 'video',
          position: { x: 3, y: 4 },
          data: { label: 'Target', mediaType: 'video', mode: 'generate', mimeType: 'video/mp4' },
        },
      ],
      edges: [
        {
          id: 'edge-1',
          sourceNodeId: 'source',
          sourceHandle: 'output:image',
          targetNodeId: 'target',
          targetHandle: 'input:firstFrame',
          order: 0,
        },
      ],
    };

    const flow = fromCanvasDocument(document);

    expect(flow.nodes[0].data.mimeType).toBe('application/octet-stream');
    expect(flow.nodes[0].width).toBe(280);
    expect(flow.nodes[0].height).toBe(190);
    expect(flow.nodes[0].style).toBeUndefined();
    expect(flow.nodes[1].data.mimeType).toBe('video/mp4');
    expect(flow.nodes[1].style).toBeUndefined();
    expect(flow.edges).toEqual([
      {
        id: 'edge-1',
        source: 'source',
        sourceHandle: 'output:image',
        target: 'target',
        targetHandle: 'input:firstFrame',
      },
    ]);
    expect(document.nodes[0].data.mimeType).toBeUndefined();
  });

  it('keeps node styles unchanged after content or manual size updates', () => {
    const node = flowNode('resized');
    node.width = 480;
    node.height = 300;
    node.style = { borderColor: '#18794e' };

    const limited = withNodeAutoGrowthLimit(node);

    expect(limited).toBe(node);
    expect(node.style).toEqual({ borderColor: '#18794e' });
  });

  it('persists node data and assigns independent input order per target port', () => {
    const document = toCanvasDocument(
      [
        flowNode('source-1', 'image', { runStatus: 'running', runProgress: 42 }),
        flowNode('source-2', 'image'),
        flowNode('target', 'video', {
          enabled: false,
          modelAlias: 'video-model',
          prompt: 'Animate the reference with a slow camera move',
          inferenceStrength: 'low',
        }),
      ],
      [
        flowEdge('edge-1', 'source-1', 'target', 'input:character'),
        flowEdge('edge-2', 'source-2', 'target', 'input:character'),
        flowEdge('edge-3', 'source-1', 'target', 'input:style'),
        flowEdge('edge-4', '', 'target'),
      ],
      8,
    );

    expect(document.revision).toBe(8);
    expect(document.nodes[0].data).not.toHaveProperty('runStatus');
    expect(document.nodes[0].data).not.toHaveProperty('runProgress');
    expect(document.nodes[2].data.modelAlias).toBe('video-model');
    expect(document.nodes[2].data.enabled).toBe(false);
    expect(document.nodes[2].data.prompt).toBe('Animate the reference with a slow camera move');
    expect(document.nodes[2].data.inferenceStrength).toBe('low');
    expect(document.edges).toEqual([
      {
        id: 'edge-1',
        sourceNodeId: 'source-1',
        sourceHandle: 'output:content',
        targetNodeId: 'target',
        targetHandle: 'input:character',
        order: 0,
      },
      {
        id: 'edge-2',
        sourceNodeId: 'source-2',
        sourceHandle: 'output:content',
        targetNodeId: 'target',
        targetHandle: 'input:character',
        order: 1,
      },
      {
        id: 'edge-3',
        sourceNodeId: 'source-1',
        sourceHandle: 'output:content',
        targetNodeId: 'target',
        targetHandle: 'input:style',
        order: 0,
      },
    ]);
  });

  it('persists React Flow node dimensions while omitting invalid runtime values', () => {
    const resized = flowNode('resized');
    resized.width = 360;
    resized.height = 260;
    const invalid = flowNode('invalid');
    invalid.width = Number.NaN;
    invalid.height = 0;

    const document = toCanvasDocument([resized, invalid], [], 1);

    expect(document.nodes[0]).toMatchObject({ width: 360, height: 260 });
    expect(document.nodes[1]).not.toHaveProperty('width');
    expect(document.nodes[1]).not.toHaveProperty('height');
  });

  it('keeps generated result metadata runtime-only', () => {
    const document = toCanvasDocument(
      [
        flowNode('target', 'image', {
          runStatus: 'succeeded',
          resultAsset: {
            assetId: 'asset-result',
            version: 2,
            contentUrl: '/v1/assets/asset-result/content',
          },
        }),
      ],
      [],
      9,
    );

    expect(document.nodes[0].data).not.toHaveProperty('resultAsset');
    expect(document.nodes[0].data).not.toHaveProperty('runStatus');
  });
});

describe('cycle detection', () => {
  it('detects an existing path from the proposed target back to the source', () => {
    const edges = [flowEdge('edge-1', 'a', 'b'), flowEdge('edge-2', 'b', 'c')];

    expect(wouldCreateCycle(edges, 'c', 'a')).toBe(true);
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(false);
    expect(wouldCreateCycle(edges, 'a', 'a')).toBe(true);
  });

  it('handles branching graphs without revisiting nodes', () => {
    const edges = [
      flowEdge('edge-1', 'a', 'b'),
      flowEdge('edge-2', 'a', 'c'),
      flowEdge('edge-3', 'c', 'd'),
    ];

    expect(wouldCreateCycle(edges, 'd', 'b')).toBe(false);
    expect(wouldCreateCycle(edges, 'd', 'a')).toBe(true);
  });
});

describe('clipboard graph transformations', () => {
  it('copies selected nodes and contained edges only', () => {
    const nodes = [flowNode('a'), flowNode('b'), flowNode('c')];
    nodes[1].selected = true;
    const clipboard = copyCanvasSelection(
      nodes,
      [flowEdge('inside', 'b', 'c'), flowEdge('outside', 'a', 'c')],
      'c',
    );

    expect(clipboard.nodes.map((node) => node.id)).toEqual(['b', 'c']);
    expect(clipboard.edges.map((edge) => edge.id)).toEqual(['inside']);
    expect(nodes[1].selected).toBe(true);
  });

  it('remaps pasted node and edge IDs while preserving graph links', () => {
    const clipboard = {
      nodes: [flowNode('a'), flowNode('b')],
      edges: [flowEdge('edge', 'a', 'b')],
    };
    const pasted = pasteCanvasClipboard(
      clipboard,
      (() => {
        let index = 0;
        return () => `id-${++index}`;
      })(),
      10,
    );

    expect(pasted.nodes.map((node) => node.id)).toEqual(['node_copy_id-1', 'node_copy_id-2']);
    expect(pasted.nodes.map((node) => node.position)).toEqual([
      { x: 20, y: 30 },
      { x: 20, y: 30 },
    ]);
    expect(pasted.edges).toEqual([
      expect.objectContaining({
        id: 'edge_copy_id-3',
        source: 'node_copy_id-1',
        target: 'node_copy_id-2',
      }),
    ]);
    expect(pasted.nodes.every((node) => node.selected)).toBe(true);
  });

  it('生成粘贴节点的新提及 ID，并保留资源身份与绑定', () => {
    const source = flowNode('source', 'text', {
      prompt: '@产品图',
      promptDocument: {
        version: 1,
        blocks: [
          { type: 'text', text: '参考 ' },
          {
            type: 'mention',
            mentionId: 'mention-original',
            assetId: 'asset-product',
            label: '产品图',
            mediaType: 'image',
            assetVersion: 3,
            binding: { entityName: '产品', semanticRole: 'style', scope: 'node' },
          },
        ],
      },
    });

    const pasted = pasteCanvasClipboard(
      { nodes: [source], edges: [] },
      (() => {
        let index = 0;
        return () => `stable-${++index}`;
      })(),
    );
    const document = pasted.nodes[0].data.promptDocument;
    expect(document?.blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention_copy_stable-2',
      assetId: 'asset-product',
      assetVersion: 3,
      binding: { entityName: '产品', semanticRole: 'style', scope: 'node' },
    });
    expect(document?.blocks[1]).not.toMatchObject({ mentionId: 'mention-original' });
  });

  it('不会把提及绑定、参数中的凭据或临时路径带入剪贴板', () => {
    const source = flowNode('sensitive', 'text', {
      parameters: {
        apiKey: 'provider-secret',
        temperature: 0.2,
        signedUrl: 'https://signed.example.invalid/input',
      },
      promptDocument: {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'mention-sensitive',
            assetId: 'asset-safe',
            label: '安全资源',
            mediaType: 'image',
            binding: {
              entityName: '角色',
              futureRole: 'appearance',
              apiKey: 'binding-secret',
              contentUrl: 'https://signed.example.invalid/binding',
              localPath: 'C:\\private\\binding.png',
            },
          },
        ],
      },
    });

    const serialized = serializeCanvasClipboard({ nodes: [source], edges: [] });
    expect(serialized).not.toContain('provider-secret');
    expect(serialized).not.toContain('binding-secret');
    expect(serialized).not.toContain('signed.example.invalid');
    expect(serialized).not.toContain('C:\\private\\binding.png');

    const parsed = parseCanvasClipboard(serialized);
    const data = parsed?.nodes[0]?.data as Record<string, any> | undefined;
    expect(data?.parameters).toEqual({ temperature: 0.2 });
    expect(data?.promptDocument?.blocks[0]).toMatchObject({
      binding: { entityName: '角色', futureRole: 'appearance' },
    });
    expect(data?.promptDocument?.blocks[0].binding).not.toHaveProperty('apiKey');
    expect(data?.promptDocument?.blocks[0].binding).not.toHaveProperty('contentUrl');
    expect(data?.promptDocument?.blocks[0].binding).not.toHaveProperty('localPath');
  });

  it('serializes a versioned browser payload and rejects unrelated text', () => {
    const clipboard = {
      nodes: [flowNode('a')],
      edges: [],
    };
    const serialized = serializeCanvasClipboard(clipboard);

    expect(parseCanvasClipboard(serialized)).toEqual(clipboard);
    expect(parseCanvasClipboard('plain text')).toBeUndefined();
    expect(
      parseCanvasClipboard(
        JSON.stringify({
          format: 'multimodal-canvas/clipboard',
          version: 99,
          nodes: [],
          edges: [],
        }),
      ),
    ).toBeUndefined();
  });

  it('rejects clipboard edges that reference nodes outside the snapshot', () => {
    const serialized = serializeCanvasClipboard({
      nodes: [flowNode('a')],
      edges: [flowEdge('edge', 'a', 'missing')],
    });

    expect(parseCanvasClipboard(serialized)).toBeUndefined();
  });

  it('removes runtime output metadata before copying or serializing', () => {
    const node = flowNode('result', 'image', {
      runStatus: 'succeeded',
      runProgress: 100,
      runError: 'old error',
      resultAsset: {
        assetId: 'asset-result',
        version: 3,
        contentUrl: '/v1/assets/asset-result/content',
      },
    });
    node.selected = true;

    const clipboard = copyCanvasSelection([node], []);
    expect(clipboard.nodes[0].data).not.toHaveProperty('runStatus');
    expect(clipboard.nodes[0].data).not.toHaveProperty('runProgress');
    expect(clipboard.nodes[0].data).not.toHaveProperty('runError');
    expect(clipboard.nodes[0].data).not.toHaveProperty('resultAsset');

    const parsed = parseCanvasClipboard(serializeCanvasClipboard(clipboard));
    expect(parsed?.nodes[0].data).not.toHaveProperty('resultAsset');
  });

  it('rejects duplicate IDs and mismatched node type/media type payloads', () => {
    const duplicateNodes = serializeCanvasClipboard({
      nodes: [flowNode('same'), flowNode('same')],
      edges: [],
    });
    expect(parseCanvasClipboard(duplicateNodes)).toBeUndefined();

    const mismatchedNode = flowNode('mismatch', 'image');
    mismatchedNode.type = 'video';
    expect(
      parseCanvasClipboard(serializeCanvasClipboard({ nodes: [mismatchedNode], edges: [] })),
    ).toBeUndefined();
  });

  it('rejects malformed enabled and dimension fields in clipboard payloads', () => {
    const node = flowNode('malformed');
    const payload = JSON.parse(serializeCanvasClipboard({ nodes: [node], edges: [] })) as {
      nodes: Array<Record<string, unknown>>;
    };
    payload.nodes[0].width = 20_001;
    expect(parseCanvasClipboard(JSON.stringify(payload))).toBeUndefined();

    payload.nodes[0].width = 200;
    (payload.nodes[0].data as Record<string, unknown>).enabled = 'yes';
    expect(parseCanvasClipboard(JSON.stringify(payload))).toBeUndefined();
  });
});

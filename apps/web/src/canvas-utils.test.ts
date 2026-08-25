import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';

import {
  fromCanvasDocument,
  copyCanvasSelection,
  pasteCanvasClipboard,
  toCanvasDocument,
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

describe('canvas document conversion', () => {
  it('maps API edges and supplies a safe MIME type for nodes without one', () => {
    const document: CanvasDocument = {
      revision: 4,
      nodes: [
        {
          id: 'source',
          type: 'image',
          position: { x: 1, y: 2 },
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
    expect(flow.nodes[1].data.mimeType).toBe('video/mp4');
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

  it('persists node data and assigns independent input order per target port', () => {
    const document = toCanvasDocument(
      [
        flowNode('source-1', 'image', { runStatus: 'running', runProgress: 42 }),
        flowNode('source-2', 'image'),
        flowNode('target', 'video', {
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
});

import { describe, expect, it } from 'vitest';
import type { Connection } from '@xyflow/react';

import { validateCanvasConnection } from './connection-utils';
import type { AssetFlowNode, FlowEdge } from './canvas-utils';

function node(id: string, mediaType: AssetFlowNode['data']['mediaType']): AssetFlowNode {
  return {
    id,
    type: mediaType,
    position: { x: 0, y: 0 },
    data: { label: id, mediaType, mode: 'generate' },
  } as AssetFlowNode;
}

function connection(
  source: string,
  target: string,
  targetHandle = 'input:content',
  sourceHandle = 'output:image',
): Connection {
  return { source, target, sourceHandle, targetHandle };
}

function edge(source: string, target: string, targetHandle = 'input:content'): FlowEdge {
  return { id: `${source}-${target}-${targetHandle}`, source, target, targetHandle };
}

describe('canvas connection validation', () => {
  it('accepts compatible references to the same target port in insertion order', () => {
    const nodes = [node('source-a', 'image'), node('source-b', 'image'), node('target', 'video')];

    expect(
      validateCanvasConnection(connection('source-a', 'target', 'input:character'), nodes, []),
    ).toEqual({
      ok: true,
    });
    expect(
      validateCanvasConnection(connection('source-b', 'target', 'input:character'), nodes, [
        edge('source-a', 'target', 'input:character'),
      ]),
    ).toEqual({ ok: true });
  });

  it('rejects incompatible port types and missing endpoints', () => {
    const nodes = [node('text', 'text'), node('target', 'video')];

    expect(
      validateCanvasConnection(connection('text', 'target', 'input:character'), nodes, []),
    ).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(
      validateCanvasConnection(
        {
          source: 'missing',
          target: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'input:content',
        },
        nodes,
        [],
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects cycles and duplicate references without mutating existing edges', () => {
    const nodes = [node('a', 'image'), node('b', 'video'), node('c', 'video')];
    const edges = [edge('a', 'b'), edge('b', 'c')];

    expect(
      validateCanvasConnection(connection('c', 'a', 'input:content', 'output:video'), nodes, edges),
    ).toEqual({
      ok: false,
      reason: 'cycle',
    });
    expect(validateCanvasConnection(connection('a', 'b'), nodes, edges)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(edges).toHaveLength(2);
  });
});

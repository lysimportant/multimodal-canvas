import { describe, expect, it } from 'vitest';
import type { Connection } from '@xyflow/react';

import {
  resolveCanvasConnectionTargetHandle,
  validateCanvasConnection,
  validateResolvedCanvasConnection,
} from './connection-utils';
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
  it('resolves a body drop to the recommended semantic target role', () => {
    const nodes = [node('source', 'image'), node('target', 'video')];
    const resolved = resolveCanvasConnectionTargetHandle(
      { source: 'source', target: 'target', sourceHandle: 'output:image', targetHandle: null },
      nodes,
    );

    expect(resolved).toEqual({
      source: 'source',
      target: 'target',
      sourceHandle: 'output:image',
      targetHandle: 'input:character',
    });
    expect(resolved && validateCanvasConnection(resolved, nodes, [])).toEqual({ ok: true });
    expect(
      validateResolvedCanvasConnection(
        { source: 'source', target: 'target', sourceHandle: 'output:image', targetHandle: null },
        nodes,
        [],
      ),
    ).toEqual({ ok: true, connection: resolved });
  });

  it('falls back to the source media output when React Flow omits sourceHandle', () => {
    const nodes = [node('source', 'image'), node('target', 'video')];
    expect(
      resolveCanvasConnectionTargetHandle(
        { source: 'source', target: 'target', sourceHandle: null, targetHandle: null },
        nodes,
      ),
    ).toMatchObject({ sourceHandle: 'output:image', targetHandle: 'input:character' });
  });

  it('resolves visual perimeter anchors but preserves explicit semantic handles', () => {
    const nodes = [node('source', 'image'), node('target', 'video')];
    expect(
      resolveCanvasConnectionTargetHandle(
        {
          source: 'source',
          target: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'visual:left',
        },
        nodes,
      ),
    ).toMatchObject({ targetHandle: 'input:character' });

    expect(
      resolveCanvasConnectionTargetHandle(
        {
          source: 'source',
          target: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'input:character',
        },
        nodes,
      ),
    ).toMatchObject({ targetHandle: 'input:character' });
  });

  it.each([
    ['text', 'image', 'input:prompt'],
    ['text', 'audio', 'input:prompt'],
    ['text', 'video', 'input:prompt'],
    ['image', 'image', 'input:content'],
    ['image', 'text', 'input:content'],
    ['audio', 'text', 'input:transcript'],
    ['audio', 'video', 'input:audioTrack'],
    ['video', 'text', 'input:content'],
    ['video', 'image', 'input:content'],
  ] as const)('uses the recommended role for %s -> %s', (sourceType, targetType, targetHandle) => {
    const nodes = [node('source', sourceType), node('target', targetType)];
    const resolved = resolveCanvasConnectionTargetHandle(
      { source: 'source', target: 'target', sourceHandle: null, targetHandle: null },
      nodes,
    );

    expect(resolved).toMatchObject({
      sourceHandle: `output:${sourceType}`,
      targetHandle,
    });
  });

  it('returns undefined when no target role can accept the source media', () => {
    const target = node('target', 'image');
    target.data = { ...target.data, mode: 'source' };
    const nodes = [node('source', 'audio'), target];
    expect(
      resolveCanvasConnectionTargetHandle(
        { source: 'source', target: 'target', sourceHandle: 'output:audio', targetHandle: null },
        nodes,
      ),
    ).toBeUndefined();
  });

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

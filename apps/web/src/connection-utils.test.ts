import { describe, expect, it } from 'vitest';
import type { Connection } from '@xyflow/react';

import {
  buildConnectedGenerateNodeConnection,
  getConnectionDropCreateGroups,
  getConnectionDropNodePosition,
  needsVideoImageRoleChoice,
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
  it('does not silently assign an image dropped on a video node body', () => {
    const nodes = [node('source', 'image'), node('target', 'video')];
    const connection = {
      source: 'source',
      target: 'target',
      sourceHandle: 'output:image',
      targetHandle: null,
    };

    expect(needsVideoImageRoleChoice(connection, nodes)).toBe(true);
    expect(resolveCanvasConnectionTargetHandle(connection, nodes)).toBeUndefined();
    expect(validateResolvedCanvasConnection(connection, nodes, [])).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('falls back to the source media output when React Flow omits sourceHandle', () => {
    const nodes = [node('source', 'text'), node('target', 'video')];
    expect(
      resolveCanvasConnectionTargetHandle(
        { source: 'source', target: 'target', sourceHandle: null, targetHandle: null },
        nodes,
      ),
    ).toMatchObject({ sourceHandle: 'output:text', targetHandle: 'input:prompt' });
  });

  it('treats visual perimeter drops as role choices and preserves explicit semantic handles', () => {
    const nodes = [node('source', 'image'), node('target', 'video')];
    expect(
      needsVideoImageRoleChoice(
        {
          source: 'source',
          target: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'visual:left',
        },
        nodes,
      ),
    ).toBe(true);
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
    ).toBeUndefined();

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
    expect(
      resolveCanvasConnectionTargetHandle(
        {
          source: 'source',
          target: 'target',
          sourceHandle: 'output:image',
          targetHandle: 'input:referenceImage',
        },
        nodes,
      ),
    ).toMatchObject({ targetHandle: 'input:referenceImage' });
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

describe('connection drop create options', () => {
  it('offers image-to-image and video first-frame actions from an image output', () => {
    const groups = getConnectionDropCreateGroups({
      node: node('source', 'image'),
      handleType: 'source',
      handleId: 'output:image',
    });

    expect(groups.map((group) => group.mediaType)).toEqual(['image', 'video']);
    expect(groups[0]?.options.map((option) => option.label)).toEqual(['图生图']);
    expect(groups[1]?.options.map((option) => [option.label, option.role])).toEqual([
      ['视频首帧', 'firstFrame'],
      ['视频尾帧', 'lastFrame'],
      ['视频角色', 'character'],
      ['视频风格', 'style'],
      ['视频参考图', 'referenceImage'],
    ]);
  });

  it('offers prompt-driven media nodes from a text output', () => {
    const groups = getConnectionDropCreateGroups({
      node: node('prompt', 'text'),
      handleType: 'source',
      handleId: 'output:text',
    });

    expect(groups.flatMap((group) => group.options.map((option) => option.label))).toEqual([
      '文生文',
      '文生图',
      '文生音频',
      '文生视频',
    ]);
  });

  it('only offers image nodes when dragging out of a video first-frame input', () => {
    const groups = getConnectionDropCreateGroups({
      node: node('target', 'video'),
      handleType: 'target',
      handleId: 'input:firstFrame',
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.options).toEqual([
      expect.objectContaining({
        mediaType: 'image',
        role: 'firstFrame',
        label: '创建图片节点',
      }),
    ]);
  });

  it('places downstream nodes at the drop x and upstream nodes to the left', () => {
    expect(getConnectionDropNodePosition({ x: 220, y: 160 }, 'image', 'source')).toEqual({
      x: 220,
      y: 27,
    });
    expect(getConnectionDropNodePosition({ x: 220, y: 160 }, 'image', 'target')).toEqual({
      x: -180,
      y: 27,
    });
  });

  it('builds downstream and upstream connections from a drop-create request', () => {
    const existing = node('image-1', 'image');
    expect(
      buildConnectedGenerateNodeConnection(
        {
          mediaType: 'video',
          position: { x: 10, y: 20 },
          existingNodeId: existing.id,
          handleType: 'source',
          handleId: 'output:image',
          role: 'firstFrame',
          label: '视频首帧',
        },
        'video-1',
        existing,
      ),
    ).toEqual({
      source: 'image-1',
      sourceHandle: 'output:image',
      target: 'video-1',
      targetHandle: 'input:firstFrame',
    });

    const video = node('video-1', 'video');
    expect(
      buildConnectedGenerateNodeConnection(
        {
          mediaType: 'image',
          position: { x: 10, y: 20 },
          existingNodeId: video.id,
          handleType: 'target',
          handleId: 'input:firstFrame',
          role: 'firstFrame',
          label: '创建图片节点',
        },
        'image-2',
        video,
      ),
    ).toEqual({
      source: 'image-2',
      sourceHandle: 'output:image',
      target: 'video-1',
      targetHandle: 'input:firstFrame',
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  assertWorkflowModelAliases,
  createInitialWorkflowState,
  createNodeRunSnapshot,
  replaceWorkflowNodeState,
  workflowExecutionOrder,
} from './workflow-dag';

const snapshot = {
  projectId: 'project_1',
  canvasRevision: 7,
  targetNodeId: 'node_video',
  modelAlias: 'video-model',
  parameters: { prompt: 'only the final node receives this prompt', resolution: '1080p' },
  submittedAt: '2026-08-27T00:00:00.000Z',
  nodes: [
    {
      id: 'node_prompt',
      type: 'text' as const,
      position: { x: 0, y: 0 },
      data: { label: 'Outline prompt', mediaType: 'text' as const, mode: 'source' as const },
    },
    {
      id: 'node_draft',
      type: 'text' as const,
      position: { x: 200, y: 0 },
      data: { label: 'Draft', mediaType: 'text' as const, mode: 'transform' as const },
    },
    {
      id: 'node_style',
      type: 'image' as const,
      position: { x: 0, y: 200 },
      data: {
        label: 'Style source',
        mediaType: 'image' as const,
        mode: 'source' as const,
        assetId: 'asset_style',
        contentUrl: '/v1/assets/asset_style/content',
        mimeType: 'image/png',
      },
    },
    {
      id: 'node_image',
      type: 'image' as const,
      position: { x: 200, y: 200 },
      data: {
        label: 'Key frame',
        mediaType: 'image' as const,
        mode: 'generate' as const,
        modelAlias: 'image-override',
        inferenceStrength: 'high' as const,
      },
    },
    {
      id: 'node_video',
      type: 'video' as const,
      position: { x: 400, y: 100 },
      data: { label: 'Video', mediaType: 'video' as const, mode: 'generate' as const },
    },
  ],
  edges: [
    {
      id: 'edge_prompt_draft',
      sourceNodeId: 'node_prompt',
      sourceHandle: 'output:text',
      targetNodeId: 'node_draft',
      targetHandle: 'input:content',
      order: 0,
    },
    {
      id: 'edge_draft_image',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_image',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_style_image',
      sourceNodeId: 'node_style',
      sourceHandle: 'output:image',
      targetNodeId: 'node_image',
      targetHandle: 'input:style',
      order: 1,
    },
    {
      id: 'edge_draft_video',
      sourceNodeId: 'node_draft',
      sourceHandle: 'output:text',
      targetNodeId: 'node_video',
      targetHandle: 'input:prompt',
      order: 0,
    },
    {
      id: 'edge_image_video',
      sourceNodeId: 'node_image',
      sourceHandle: 'output:image',
      targetNodeId: 'node_video',
      targetHandle: 'input:firstFrame',
      order: 1,
    },
  ],
  inputs: [
    {
      nodeId: 'node_draft',
      role: 'prompt' as const,
      sortOrder: 0,
      snapshot: {
        id: 'node_draft',
        type: 'text' as const,
        position: { x: 200, y: 0 },
        data: { label: 'Draft', mediaType: 'text' as const, mode: 'transform' as const },
      },
    },
    {
      nodeId: 'node_image',
      role: 'firstFrame' as const,
      sortOrder: 1,
      snapshot: {
        id: 'node_image',
        type: 'image' as const,
        position: { x: 200, y: 200 },
        data: {
          label: 'Key frame',
          mediaType: 'image' as const,
          mode: 'generate' as const,
          modelAlias: 'image-override',
          inferenceStrength: 'high' as const,
        },
      },
    },
  ],
};

describe('frozen workflow DAG', () => {
  it('uses a stable topological order for fan-in dependencies', () => {
    expect(workflowExecutionOrder(snapshot).map((node) => node.id)).toEqual([
      'node_prompt',
      'node_draft',
      'node_style',
      'node_image',
      'node_video',
    ]);
  });

  it('passes archived upstream output into a derived node snapshot only', () => {
    let state = createInitialWorkflowState(snapshot);
    state = replaceWorkflowNodeState(state, {
      nodeId: 'node_draft',
      status: 'succeeded',
      result: {
        provider: 'mock',
        summary: 'draft complete',
        targetNodeId: 'node_draft',
        mediaType: 'text',
        inputCount: 1,
        asset: {
          assetId: 'asset_draft',
          version: 1,
          contentUrl: '/v1/assets/asset_draft/content',
          mimeType: 'text/plain',
        },
      },
    });

    const imageSnapshot = createNodeRunSnapshot(snapshot, state, 'node_image');

    expect(imageSnapshot.targetNodeId).toBe('node_image');
    expect(imageSnapshot.modelAlias).toBe('image-override');
    expect(imageSnapshot.parameters).toEqual({ resolution: '1080p', inferenceStrength: 'high' });
    expect(imageSnapshot.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'node_draft',
          role: 'prompt',
          sourceAssetId: 'asset_draft',
          snapshot: expect.objectContaining({
            data: expect.objectContaining({ contentUrl: '/v1/assets/asset_draft/content' }),
          }),
        }),
        expect.objectContaining({
          nodeId: 'node_style',
          role: 'style',
          sourceAssetId: 'asset_style',
        }),
      ]),
    );
    expect(imageSnapshot.edges.map((edge) => edge.id)).toEqual([
      'edge_draft_image',
      'edge_style_image',
    ]);
  });

  it('requires a frozen model for every provider-backed intermediate node', () => {
    const frozenModels = {
      ...snapshot,
      nodes: snapshot.nodes.map((node) =>
        node.id === 'node_draft'
          ? { ...node, data: { ...node.data, modelAlias: 'text-frozen' } }
          : node,
      ),
    };

    expect(() => assertWorkflowModelAliases(snapshot)).toThrow(
      'workflow node node_draft is missing a frozen model alias',
    );
    expect(() => assertWorkflowModelAliases(frozenModels)).not.toThrow();
    expect(
      createNodeRunSnapshot(frozenModels, createInitialWorkflowState(frozenModels), 'node_draft')
        .modelAlias,
    ).toBe('text-frozen');
  });

  it('keeps multiple roles from one upstream without duplicating its node', () => {
    const repeatedSourceSnapshot = {
      ...snapshot,
      edges: [
        ...snapshot.edges,
        {
          id: 'edge_draft_image_negative',
          sourceNodeId: 'node_draft',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:negativePrompt',
          order: 2,
        },
      ],
    };

    const imageSnapshot = createNodeRunSnapshot(
      repeatedSourceSnapshot,
      createInitialWorkflowState(repeatedSourceSnapshot),
      'node_image',
    );

    expect(imageSnapshot.nodes.filter((node) => node.id === 'node_draft')).toHaveLength(1);
    expect(imageSnapshot.inputs.filter((input) => input.nodeId === 'node_draft')).toMatchObject([
      { role: 'prompt', sortOrder: 0 },
      { role: 'negativePrompt', sortOrder: 2 },
    ]);
  });
});

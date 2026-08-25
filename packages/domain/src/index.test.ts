import { describe, expect, it } from 'vitest';

import {
  assetSchema,
  canTransitionRunStatus,
  canvasDocumentSchema,
  mediaTypes,
  nodeModes,
  portRoles,
  runJobDataSchema,
  runSnapshotSchema,
  targetPortRolesForMediaType,
} from './index';

describe('canvas protocol', () => {
  it('exposes the supported media, modes, and port roles', () => {
    expect(mediaTypes).toEqual(['text', 'image', 'audio', 'video']);
    expect(nodeModes).toEqual(['source', 'generate', 'transform']);
    expect(portRoles).toContain('character');
    expect(targetPortRolesForMediaType('video')).toEqual(
      expect.arrayContaining(['prompt', 'character', 'firstFrame', 'lastFrame', 'audioTrack']),
    );
  });

  it('validates a minimal canvas document', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_text',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
      ],
      edges: [],
    });

    expect(document.nodes).toHaveLength(1);
  });

  it('accepts node prompt and inference strength settings', () => {
    const document = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Image',
            mediaType: 'image',
            mode: 'generate',
            prompt: 'A quiet mountain lake at dawn',
            inferenceStrength: 'high',
          },
        },
      ],
      edges: [],
    });

    expect(document.nodes[0].data.prompt).toBe('A quiet mountain lake at dawn');
    expect(document.nodes[0].data.inferenceStrength).toBe('high');
  });

  it('preserves optional node prompt and inference strength settings', () => {
    const node = canvasDocumentSchema.parse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            prompt: '  A cinematic portrait  ',
            inferenceStrength: 'high',
          },
        },
      ],
      edges: [],
    }).nodes[0];

    expect(node.data.prompt).toBe('A cinematic portrait');
    expect(node.data.inferenceStrength).toBe('high');
  });

  it('rejects invalid node prompt and inference strength settings', () => {
    const invalidPrompt = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            prompt: 'x'.repeat(20_001),
          },
        },
      ],
      edges: [],
    });
    const invalidStrength = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_image',
          type: 'image',
          position: { x: 0, y: 0 },
          data: {
            label: 'Generate',
            mediaType: 'image',
            mode: 'generate',
            inferenceStrength: 'extreme',
          },
        },
      ],
      edges: [],
    });

    expect(invalidPrompt.success).toBe(false);
    expect(invalidStrength.success).toBe(false);
  });

  it('validates an uploaded asset reference', () => {
    const asset = assetSchema.parse({
      id: 'asset_image',
      name: 'reference.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 128,
      status: 'ready',
      contentUrl: '/v1/assets/asset_image/content',
    });

    expect(asset.mediaType).toBe('image');
  });

  it('accepts compatible reference inputs and rejects cycles', () => {
    const valid = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
    });
    expect(valid.success).toBe(true);

    const cyclic = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_a',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'A', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_b',
          type: 'text',
          position: { x: 200, y: 0 },
          data: { label: 'B', mediaType: 'text', mode: 'transform' },
        },
      ],
      edges: [
        {
          id: 'edge_ab',
          sourceNodeId: 'node_a',
          sourceHandle: 'output:text',
          targetNodeId: 'node_b',
          targetHandle: 'input:content',
          order: 0,
        },
        {
          id: 'edge_ba',
          sourceNodeId: 'node_b',
          sourceHandle: 'output:text',
          targetNodeId: 'node_a',
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    });
    expect(cyclic.success).toBe(false);
    if (!cyclic.success)
      expect(cyclic.error.issues).toContainEqual(
        expect.objectContaining({ message: 'canvas graph must be acyclic' }),
      );
  });

  it('rejects incompatible reference inputs', () => {
    const result = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_audio',
          type: 'audio',
          position: { x: 0, y: 0 },
          data: { label: 'Audio', mediaType: 'audio', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Image', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_audio_style',
          sourceNodeId: 'node_audio',
          sourceHandle: 'output:audio',
          targetNodeId: 'node_image',
          targetHandle: 'input:style',
          order: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects connections into source nodes', () => {
    const result = canvasDocumentSchema.safeParse({
      revision: 0,
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_source_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Reference', mediaType: 'image', mode: 'source' },
        },
      ],
      edges: [
        {
          id: 'edge_invalid_target',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_source_image',
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('validates an immutable run snapshot and its status transitions', () => {
    const snapshot = runSnapshotSchema.parse({
      projectId: 'project_1',
      canvasRevision: 3,
      targetNodeId: 'node_image',
      modelAlias: 'mock-image',
      parameters: {},
      submittedAt: '2026-08-24T00:00:00.000Z',
      nodes: [
        {
          id: 'node_prompt',
          type: 'text',
          position: { x: 0, y: 0 },
          data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
        },
        {
          id: 'node_image',
          type: 'image',
          position: { x: 200, y: 0 },
          data: { label: 'Generate', mediaType: 'image', mode: 'generate' },
        },
      ],
      edges: [
        {
          id: 'edge_prompt',
          sourceNodeId: 'node_prompt',
          sourceHandle: 'output:text',
          targetNodeId: 'node_image',
          targetHandle: 'input:prompt',
          order: 0,
        },
      ],
      inputs: [
        {
          nodeId: 'node_prompt',
          role: 'prompt',
          sortOrder: 0,
          snapshot: {
            id: 'node_prompt',
            type: 'text',
            position: { x: 0, y: 0 },
            data: { label: 'Prompt', mediaType: 'text', mode: 'source' },
          },
        },
      ],
    });

    expect(snapshot.canvasRevision).toBe(3);
    expect(canTransitionRunStatus('queued', 'preparing')).toBe(true);
    expect(canTransitionRunStatus('succeeded', 'running')).toBe(false);
  });

  it('defaults a queued job to an active cancellation flag of false', () => {
    const result = runJobDataSchema.parse({
      runId: 'run_1',
      snapshot: {
        projectId: 'project_1',
        canvasRevision: 0,
        targetNodeId: 'node_image',
        modelAlias: 'mock-image',
        parameters: {},
        submittedAt: '2026-08-24T00:00:00.000Z',
        nodes: [
          {
            id: 'node_image',
            type: 'image',
            position: { x: 0, y: 0 },
            data: { label: 'Generate', mediaType: 'image', mode: 'generate' },
          },
        ],
        edges: [],
        inputs: [],
      },
      attempt: 1,
    });

    expect(result.cancelRequested).toBe(false);
    expect(result.provider).toBe('mock');
  });
});

import { describe, expect, it } from 'vitest';

import { assetSchema, canvasDocumentSchema, mediaTypes, nodeModes, portRoles } from './index';

describe('canvas protocol', () => {
  it('exposes the supported media, modes, and port roles', () => {
    expect(mediaTypes).toEqual(['text', 'image', 'audio', 'video']);
    expect(nodeModes).toEqual(['source', 'generate', 'transform']);
    expect(portRoles).toContain('character');
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
});

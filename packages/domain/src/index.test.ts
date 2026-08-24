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
});

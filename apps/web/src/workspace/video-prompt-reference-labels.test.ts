import { describe, expect, it } from 'vitest';
import type { PromptDocument, VideoReferenceCapability } from '@multimodal-canvas/domain';
import {
  collectVideoPromptReferences,
  videoPromptReferenceLabels,
} from './video-prompt-reference-labels';
import { previewVideoPrompt } from './video-prompt-preview';
import { collectConnectedPromptAssets, type ConnectedPromptAsset } from './connected-prompt-assets';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';

function mention(
  assetId: string,
  mediaType: 'image' | 'video' | 'audio' = 'image',
  version = 1,
  id = assetId,
  semanticRole?: string,
): PromptDocument['blocks'][number] {
  return {
    type: 'mention',
    inline: true,
    mentionId: id,
    assetId,
    assetVersion: version,
    mediaType,
    label: assetId,
    ...(semanticRole ? { semanticRole } : {}),
  };
}

describe('video prompt reference labels', () => {
  const videoReferences: VideoReferenceCapability = {
    version: 1,
    adapter: 'seedance-video',
    maxImages: 30,
    maxVideos: 10,
    maxAudios: 10,
    tokenSyntax: 'numbered-media',
  };

  it('counts mixed media independently and reuses repeated references after resource ordering', () => {
    const labels = videoPromptReferenceLabels(
      { modelAlias: 'wan3.0-video', videoMode: 'omni_reference' },
      {
        version: 1,
        blocks: [
          mention('a'),
          mention('voice', 'audio'),
          mention('b'),
          mention('a', 'image', 1, 'again'),
          mention('motion', 'video'),
        ],
      },
      [],
      [
        { id: 'ordered:b', assetId: 'b', assetVersion: 1, mediaType: 'image', name: 'B' },
        { id: 'ordered:a', assetId: 'a', assetVersion: 1, mediaType: 'image', name: 'A' },
      ],
    );
    expect([...labels]).toEqual([
      ['["b",1]', ['Image1']],
      ['["a",1]', ['Image2']],
      ['["voice",1]', ['Audio1']],
      ['["motion",1]', ['Video1']],
    ]);
  });

  it('keeps versions and distinct keyframe roles separate while matching connected references', () => {
    const connected: ConnectedPromptAsset[] = [
      {
        id: 'a',
        name: 'A',
        mediaType: 'image',
        assetVersion: 1,
        videoInputBindings: [
          { nodeId: 'first', role: 'firstFrame', sortOrder: 0 },
          { nodeId: 'ref', role: 'referenceImage', sortOrder: 0 },
        ],
      },
    ];
    const labels = videoPromptReferenceLabels(
      { videoMode: 'omni_reference' },
      {
        version: 1,
        blocks: [mention('a'), mention('a', 'image', 2, 'old')],
      },
      connected,
    );
    expect(labels.get('["a",1]')).toEqual(['Image1', 'Image2']);
    expect(labels.get('["a",2]')).toEqual(['Image3']);
  });

  it('numbers attached resources without changing the prompt and leaves unfrozen identity unnumbered', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '保持构图' },
        {
          type: 'mention',
          inline: true,
          mentionId: 'unknown',
          assetId: 'unknown',
          mediaType: 'image',
          label: 'Unknown',
        },
      ],
    };
    const before = structuredClone(document);
    const labels = videoPromptReferenceLabels(
      {},
      document,
      [],
      [
        {
          id: 'attached:voice',
          attached: true,
          assetId: 'voice',
          assetVersion: 2,
          mediaType: 'audio',
          name: 'Voice',
        },
      ],
    );
    expect([...labels]).toEqual([['["voice",2]', ['Audio1']]]);
    expect(document).toEqual(before);
  });

  it('retains every connected role and saved per-handle order behind deduplicated resource cards', () => {
    const source = (id: string): AssetFlowNode => ({
      id,
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType: 'image',
        mode: 'source',
        assetId: 'shared',
        contentUrl: '/v1/assets/shared/versions/1/content',
      },
    });
    const target: AssetFlowNode = {
      id: 'target',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        label: 'Target',
        mediaType: 'video',
        mode: 'generate',
        videoMode: 'omni_reference',
      },
    };
    const edges: FlowEdge[] = [
      { id: 'a', source: 'a', target: 'target', targetHandle: 'input:referenceImage' },
      { id: 'b', source: 'b', target: 'target', targetHandle: 'input:referenceImage' },
      { id: 'c', source: 'a', target: 'target', targetHandle: 'input:firstFrame' },
    ];
    const items = collectConnectedPromptAssets('target', [source('a'), source('b'), target], edges);
    expect(items).toHaveLength(1);
    expect(items[0].videoInputBindings).toEqual([
      { nodeId: 'a', role: 'referenceImage', sortOrder: 0 },
      { nodeId: 'b', role: 'referenceImage', sortOrder: 1 },
      { nodeId: 'a', role: 'firstFrame', sortOrder: 0 },
    ]);
  });

  it('reuses five H3 image numbers across 25 cross-shot mentions when capability exists', () => {
    const blocks: PromptDocument['blocks'] = [];
    let expectedPrompt = '';
    for (let shot = 1; shot <= 5; shot += 1) {
      blocks.push({ type: 'text', text: `【镜头${shot}】` });
      expectedPrompt += `【镜头${shot}】`;
      for (let imageIndex = 1; imageIndex <= 5; imageIndex += 1) {
        blocks.push(mention(`image-${imageIndex}`, 'image', 1, `shot-${shot}-image-${imageIndex}`));
        expectedPrompt += `<Picture ${imageIndex}>`;
      }
    }

    const context = {
      modelAlias: 'minimax-h3-1',
      videoMode: 'omni_reference' as const,
      videoReferences,
    };
    const document: PromptDocument = { version: 1, blocks };
    const references = collectVideoPromptReferences(context, document);

    expect(blocks.filter((block) => block.type === 'mention')).toHaveLength(25);
    expect(previewVideoPrompt(document, context)).toBe(expectedPrompt);
    expect(references).toHaveLength(5);
    expect(references.map((reference) => reference.token)).toEqual([
      '<Picture 1>',
      '<Picture 2>',
      '<Picture 3>',
      '<Picture 4>',
      '<Picture 5>',
    ]);
    expect(references.map((reference) => reference.assetId)).toEqual([
      'image-1',
      'image-2',
      'image-3',
      'image-4',
      'image-5',
    ]);
  });

  it('reuses connected character and reference roles instead of creating H3 images 6-8', () => {
    const connected: ConnectedPromptAsset[] = Array.from({ length: 5 }, (_, index) => ({
      id: `asset-${index + 1}`,
      name: `Asset ${index + 1}`,
      mediaType: 'image',
      assetVersion: 1,
      videoInputBindings: [
        {
          nodeId: `connected-${index + 1}`,
          role: index < 3 ? ('character' as const) : ('referenceImage' as const),
          sortOrder: index,
        },
      ],
    }));
    const blocks: PromptDocument['blocks'] = [];
    let expectedPrompt = '';
    for (let shot = 1; shot <= 5; shot += 1) {
      blocks.push({ type: 'text', text: `镜头${shot}：` });
      expectedPrompt += `镜头${shot}：`;
      for (let imageIndex = 1; imageIndex <= 5; imageIndex += 1) {
        const role = imageIndex <= 3 ? 'character' : 'referenceImage';
        blocks.push(mention(`asset-${imageIndex}`, 'image', 1, `role-${shot}-${imageIndex}`, role));
        expectedPrompt += `<Picture ${imageIndex}>`;
      }
    }
    const document: PromptDocument = { version: 1, blocks };
    const context = { modelAlias: 'minimax-h3-1', videoMode: 'omni_reference' as const };
    const references = collectVideoPromptReferences(context, document, connected);

    expect(previewVideoPrompt(document, context, connected)).toBe(expectedPrompt);
    expect(references).toHaveLength(5);
    expect(references.map((reference) => reference.token)).toEqual([
      '<Picture 1>',
      '<Picture 2>',
      '<Picture 3>',
      '<Picture 4>',
      '<Picture 5>',
    ]);
  });

  it.each([
    ['unknown-video-model', undefined, 'Image 1'],
    ['doubao-seedance-2-5-260628', undefined, '图 1'],
    ['wan3.0-video', undefined, '图1'],
    ['minimax-h3-1', 'wan' as const, '图1'],
  ])(
    'uses the automatic family for %s and keeps explicit syntax %s authoritative',
    (modelAlias, videoReferenceSyntax, token) => {
      const [reference] = collectVideoPromptReferences(
        {
          modelAlias,
          videoMode: 'omni_reference',
          videoReferences,
          videoReferenceSyntax,
        },
        { version: 1, blocks: [mention('image')] },
      );
      expect(reference?.token).toBe(token);
    },
  );
});

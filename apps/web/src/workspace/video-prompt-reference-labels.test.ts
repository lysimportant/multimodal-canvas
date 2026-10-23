import { describe, expect, it } from 'vitest';
import type { PromptDocument } from '@multimodal-canvas/domain';
import { videoPromptReferenceLabels } from './video-prompt-reference-labels';
import { collectConnectedPromptAssets, type ConnectedPromptAsset } from './connected-prompt-assets';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';

function mention(
  assetId: string,
  mediaType: 'image' | 'video' | 'audio' = 'image',
  version = 1,
  id = assetId,
): PromptDocument['blocks'][number] {
  return {
    type: 'mention',
    inline: true,
    mentionId: id,
    assetId,
    assetVersion: version,
    mediaType,
    label: assetId,
  };
}

describe('video prompt reference labels', () => {
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
});

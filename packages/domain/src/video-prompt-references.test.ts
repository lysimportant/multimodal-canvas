import { describe, expect, it } from 'vitest';
import {
  buildVideoPromptReferences,
  orderVideoPromptMedia,
  type VideoPromptMediaDescriptor,
} from './video-prompt-references.js';

describe('video prompt references', () => {
  it('counts each media type independently and reuses only the same asset version and role', () => {
    const items: VideoPromptMediaDescriptor[] = [
      { assetId: 'a', assetVersion: 1, mediaType: 'image', role: 'referenceImage' },
      { assetId: 'v', assetVersion: 1, mediaType: 'video', role: 'content' },
      { assetId: 'a', assetVersion: 1, mediaType: 'image', role: 'referenceImage' },
      { assetId: 'a', assetVersion: 2, mediaType: 'image', role: 'referenceImage' },
      { assetId: 'a', assetVersion: 1, mediaType: 'image', role: 'firstFrame' },
      { assetId: 's', assetVersion: 1, mediaType: 'audio', role: 'audioTrack' },
    ];
    expect(buildVideoPromptReferences(items).map((item) => item.displayLabel)).toEqual([
      'Image1',
      'Video1',
      'Image1',
      'Image2',
      'Image3',
      'Audio1',
    ]);
    expect(buildVideoPromptReferences(items, 'seedance').map((item) => item.token)).toEqual([
      '图 1',
      '视频 1',
      '图 1',
      '图 2',
      '图 3',
      '音频 1',
    ]);
    expect(buildVideoPromptReferences(items, 'wan').map((item) => item.token)).toEqual([
      '图1',
      '视频1',
      '图1',
      '图2',
      '图3',
      '音频1',
    ]);
    expect(
      buildVideoPromptReferences(items, 'generic', { deduplicate: false }).map(
        (item) => item.displayLabel,
      ),
    ).toEqual(['Image1', 'Video1', 'Image2', 'Image3', 'Image4', 'Audio1']);
    expect(buildVideoPromptReferences(items, 'h3').map((item) => item.token)).toEqual([
      '<Picture 1>',
      '<Video 1>',
      '<Picture 1>',
      '<Picture 2>',
      '<Picture 3>',
      '<Audio 1>',
    ]);
  });

  it('keeps frame slots and applies explicit version ordering to other references without mutation', () => {
    const inputs = [
      {
        nodeId: 'first',
        sortOrder: 0,
        assetId: 'f',
        assetVersion: 1,
        mediaType: 'image' as const,
        role: 'firstFrame',
      },
      {
        nodeId: 'a1',
        sortOrder: 1,
        assetId: 'a',
        assetVersion: 1,
        mediaType: 'image' as const,
        role: 'referenceImage',
      },
      {
        nodeId: 'last',
        sortOrder: 2,
        assetId: 'l',
        assetVersion: 1,
        mediaType: 'image' as const,
        role: 'lastFrame',
      },
      {
        nodeId: 'a2',
        sortOrder: 3,
        assetId: 'a',
        assetVersion: 2,
        mediaType: 'image' as const,
        role: 'referenceImage',
      },
    ];
    const before = structuredClone(inputs);
    expect(
      orderVideoPromptMedia(inputs, [
        { id: 'ordered:a', name: 'a', assetId: 'a', assetVersion: 2, mediaType: 'image' },
      ]).map((item) => item.nodeId),
    ).toEqual(['first', 'a2', 'last', 'a1']);
    expect(inputs).toEqual(before);
  });
});

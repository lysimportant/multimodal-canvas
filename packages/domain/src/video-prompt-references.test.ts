import { describe, expect, it } from 'vitest';
import {
  buildVideoPromptReferences,
  orderVideoPromptMedia,
  renderVideoPromptReferenceDocument,
  VideoPromptReferenceMappingError,
  videoPromptTokenFamilyForModel,
  videoPromptTokenFamilyForNode,
  type VideoPromptMediaDescriptor,
} from './video-prompt-references.js';
import type { PromptDocument, PromptMention } from './index.js';

describe('video prompt references', () => {
  const mention: PromptMention = {
    type: 'mention',
    mentionId: 'inline-image',
    assetId: 'image-asset',
    assetVersion: 1,
    mediaType: 'image',
    label: '文件显示名不参与转换',
    inline: true,
  };

  it.each([
    ['doubao-seedance-2-5-260628', '图 1'],
    ['wan3.0-video', '图1'],
    ['MiniMax-H3', '<Picture 1>'],
    ['mt-h3', '<Picture 1>'],
    ['grok-imagine-video-1.5.1', 'Image 1'],
  ])('renders %s references with the same tokens used for submission', (modelAlias, token) => {
    const refs = buildVideoPromptReferences(
      [{ ...mention, role: 'referenceImage', mediaType: 'image' as const }],
      videoPromptTokenFamilyForModel(modelAlias),
    );
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '使用' },
        { ...mention, entityName: ' 小明 ', binding: { entityName: '不覆盖' } },
        { type: 'text', text: '和' },
        { ...mention, mentionId: 'repeat', binding: { entityName: ' 成年小明 ' } },
      ],
    };
    const before = structuredClone(document);
    expect(renderVideoPromptReferenceDocument(document, refs, { modelAlias }).blocks).toEqual([
      { type: 'text', text: '使用' },
      { type: 'text', text: `${token}（小明）` },
      { type: 'text', text: '和' },
      { type: 'text', text: `${token}（成年小明）` },
    ]);
    expect(document).toEqual(before);
  });

  it('lets a node override the automatic token family', () => {
    expect(videoPromptTokenFamilyForNode('mt-h3', undefined)).toBe('h3');
    expect(videoPromptTokenFamilyForNode('mt-h3', 'wan')).toBe('wan');
    expect(videoPromptTokenFamilyForNode('doubao-seedance-2-5-260628', 'generic')).toBe('generic');
    expect(videoPromptTokenFamilyForNode('MiniMax-H3', 'seedance')).toBe('seedance');
    expect(videoPromptTokenFamilyForNode(undefined, 'h3')).toBe('h3');
  });

  it('honors frozen versions, skips execution-only blocks and separates following digits', () => {
    const refs = buildVideoPromptReferences(
      [{ ...mention, assetVersion: 2, role: 'referenceImage', mediaType: 'image' as const }],
      'wan',
    );
    const legacy = { ...mention, inline: undefined, mentionId: 'legacy' };
    const textMention = { ...mention, mediaType: 'text' as const, mentionId: 'text' };
    const document: PromptDocument = {
      version: 1,
      blocks: [
        mention,
        { ...mention, executionOnly: true, mentionId: 'execution' },
        { type: 'text', text: '' },
        { type: 'text', text: '２人同行' },
        legacy,
        textMention,
      ],
    };
    expect(
      renderVideoPromptReferenceDocument(document, refs, {
        modelAlias: 'wan3.0-video',
        videoMode: 'omni_reference',
        resolveAssetVersion: () => 2,
      }).blocks,
    ).toEqual([
      { type: 'text', text: '图1 ' },
      { type: 'text', text: '' },
      { type: 'text', text: '' },
      { type: 'text', text: '２人同行' },
      legacy,
      textMention,
    ]);
    expect(() => renderVideoPromptReferenceDocument(document, refs, {})).toThrow(
      VideoPromptReferenceMappingError,
    );
  });

  it('reports the unmapped mention instead of guessing its material identity', () => {
    const document: PromptDocument = { version: 1, blocks: [mention] };
    try {
      renderVideoPromptReferenceDocument(document, [], {});
      throw new Error('Expected an unmapped reference error');
    } catch (error) {
      expect(error).toBeInstanceOf(VideoPromptReferenceMappingError);
      expect((error as VideoPromptReferenceMappingError).mention).toBe(mention);
      expect((error as Error).message).toBe('视频引用没有对应的实际发送素材');
    }
  });

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

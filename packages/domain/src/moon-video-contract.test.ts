import { describe, expect, it } from 'vitest';

import {
  moonVideoContractForModel,
  moonVideoModelAliases,
  precheckVideoGenerationInputs,
  videoFamilyForModel,
  videoModeCapability,
  type PortRole,
} from './index';

const expectedAliases = [
  'sd2mini',
  'sd2-930-face',
  'sd2-930-fast',
  'sd2-930-no-face',
  'sd2.5-30-10-face',
  'sd2.5-30-10-10-480',
  'sd2.5-30-10-10',
  'sd2.5-30-10-10-per-request',
  'seedance2.0-9-3-3-PT',
  'seedance2.5-30-10-10-PT',
  'seedance2.0-fast-PT',
  'seedance-2-5-official',
  'artsdance-2-0-pro-260801',
  'grok-v1.5-video',
] as const;

function videoInput(
  id: string,
  role: PortRole,
  sortOrder: number,
  mediaType: 'text' | 'image' | 'audio' | 'video' = 'image',
  sourceDurationSeconds?: number,
) {
  return {
    nodeId: id,
    role,
    sortOrder,
    ...(sourceDurationSeconds === undefined ? {} : { sourceDurationSeconds }),
    snapshot: {
      id,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType,
        mode: 'source' as const,
        ...(mediaType === 'text'
          ? { prompt: `${role} value` }
          : { contentUrl: `https://assets.example/${id}` }),
      },
    },
  };
}

describe('Moon video contracts', () => {
  it('contains the exact newly supported model IDs and no aliases by prefix', () => {
    expect(moonVideoModelAliases).toEqual([...expectedAliases].sort());
    for (const modelAlias of expectedAliases) {
      expect(moonVideoContractForModel(modelAlias)?.modelAlias).toBe(modelAlias);
    }
    expect(moonVideoContractForModel('SD2-930-FAST')).toBeUndefined();
    expect(moonVideoContractForModel('sd2-930-fast-v2')).toBeUndefined();
    expect(moonVideoContractForModel('doubao-seedance-2-5-260628')).toBeUndefined();
    expect(moonVideoContractForModel('__proto__')).toBeUndefined();
    expect(moonVideoContractForModel('constructor')).toBeUndefined();
  });

  it('keeps new Moon families distinct from the existing Seedance and Grok families', () => {
    expect(videoFamilyForModel('sd2-930-fast')).toBe('moon-budget');
    expect(videoFamilyForModel('seedance2.0-fast-PT')).toBe('moon-pt');
    expect(videoFamilyForModel('seedance-2-5-official')).toBe('moon-seedance-2.5-official');
    expect(videoFamilyForModel('artsdance-2-0-pro-260801')).toBe('moon-seedance-2');
    expect(videoFamilyForModel('grok-v1.5-video')).toBe('moon-grok-v1.5-video');
    expect(videoFamilyForModel('doubao-seedance-2-5-260628')).toBe('seedance-2.5');
    expect(videoFamilyForModel('grok-imagine-video-1.5')).toBe('grok-imagine-video-1.5');
  });

  it.each([
    ['sd2mini', 'moon-budget', { '480p': [5, 15], '720p': [5, 12] }, [9, 3, 3, 15]],
    ['sd2-930-face', 'moon-budget', { '720p': [4, 30] }, [9, 0, 3, 12]],
    ['sd2-930-fast', 'moon-budget', { '720p': [5, 15] }, [9, 3, 3, 15]],
    ['sd2-930-no-face', 'moon-budget', { '720p': [4, 15] }, [9, 3, 3, 15]],
    ['sd2.5-30-10-face', 'moon-budget', { '720p': [4, 30] }, [30, 0, 10, 40]],
    ['sd2.5-30-10-10-480', 'moon-budget', { '480p': [4, 30] }, [30, 10, 10, 50]],
    ['sd2.5-30-10-10', 'moon-budget', { '720p': [4, 30] }, [30, 10, 10, 50]],
    ['sd2.5-30-10-10-per-request', 'moon-budget', { '720p': [5, 30] }, [30, 3, 3, 36]],
    ['seedance2.0-9-3-3-PT', 'moon-pt', { '480p': [5, 15], '720p': [5, 15] }, [9, 3, 3, 15]],
    ['seedance2.5-30-10-10-PT', 'moon-pt', { '480p': [5, 30], '720p': [5, 30] }, [30, 10, 10, 50]],
    ['seedance2.0-fast-PT', 'moon-pt', { '480p': [5, 15], '720p': [5, 15] }, [9, 0, 3, 12]],
    [
      'seedance-2-5-official',
      'moon-seedance-2.5-official',
      { '720p': [4, 30], '1080p': [4, 30] },
      [30, 10, 10, 50],
    ],
    [
      'artsdance-2-0-pro-260801',
      'moon-seedance-2',
      { '480p': [4, 15], '720p': [4, 15], '1080p': [4, 15], '4k': [4, 15] },
      [9, 3, 3, 15],
    ],
    [
      'grok-v1.5-video',
      'moon-grok-v1.5-video',
      { '720p': [4, 15], '1080p': [4, 15] },
      [7, 0, 0, 7],
    ],
  ] as const)(
    'exposes exact family, resolution ranges, and reference limits for %s',
    (modelAlias, family, ranges, [images, videos, audios, total]) => {
      const contract = moonVideoContractForModel(modelAlias);
      expect(contract?.family).toBe(family);
      expect(contract?.resolutions).toEqual(
        Object.fromEntries(
          Object.entries(ranges).map(([resolution, [min, max]]) => [resolution, { min, max }]),
        ),
      );
      expect(contract?.referenceLimits).toEqual({ images, videos, audios, total });
    },
  );

  it('keeps sd2-930-fast omni references live with its documented limits', () => {
    const contract = moonVideoContractForModel('sd2-930-fast');
    expect(contract).toMatchObject({
      family: 'moon-budget',
      defaultResolution: '720p',
      resolutions: { '720p': { min: 5, max: 15 } },
      referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
      supportsAutomaticDuration: false,
    });
    expect(videoModeCapability('omni_reference', 'sd2-930-fast')).toMatchObject({
      selectable: true,
      livePost: true,
    });
    expect(videoModeCapability('video_edit', 'sd2-930-fast').selectable).toBe(false);
    const precheck = precheckVideoGenerationInputs(
      [
        videoInput('prompt', 'prompt', 0, 'text'),
        videoInput('reference', 'referenceImage', 1, 'image'),
      ],
      { modelAlias: 'sd2-930-fast', videoMode: 'omni_reference' },
    );
    expect(precheck.issues).toEqual([]);
  });

  it('counts legacy first and last frames against the Moon image limit', () => {
    const inputs = [
      ...Array.from({ length: 9 }, (_, index) =>
        videoInput(`reference-${index}`, 'referenceImage', index),
      ),
      videoInput('first', 'firstFrame', 9),
      videoInput('last', 'lastFrame', 10),
    ];

    expect(
      precheckVideoGenerationInputs(inputs, { modelAlias: 'sd2-930-fast' }).issues,
    ).toContainEqual({
      code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
      role: 'referenceImage',
      message: 'New API video 参考图数量超过模型上限 9',
    });
  });

  it('allows Grok up to seven images but rejects the eighth and any tail frame', () => {
    const references = [
      videoInput('prompt', 'prompt', 0, 'text'),
      ...Array.from({ length: 7 }, (_, index) =>
        videoInput(`reference-${index}`, 'referenceImage', index + 1),
      ),
    ];
    expect(
      precheckVideoGenerationInputs(references, {
        modelAlias: 'grok-v1.5-video',
        videoMode: 'omni_reference',
      }).issues,
    ).toEqual([]);
    const tooMany = precheckVideoGenerationInputs(
      [...references, videoInput('reference-7', 'referenceImage', 8)],
      { modelAlias: 'grok-v1.5-video', videoMode: 'omni_reference' },
    );
    expect(tooMany.issues).toEqual(
      expect.arrayContaining([
        {
          code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
          role: 'referenceImage',
          message: 'New API video 参考图数量超过模型上限 7',
        },
        {
          code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
          message: 'New API video 参考素材总数超过模型上限 7',
        },
      ]),
    );
    const tailFrame = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('last', 'lastFrame', 1)],
      { modelAlias: 'grok-v1.5-video', videoMode: 'omni_reference' },
    );
    expect(tailFrame.issues.map((issue) => issue.role)).toContain('lastFrame');
  });

  it('enforces PT frozen reference durations and frame/reference exclusivity', () => {
    const audioOnly = precheckVideoGenerationInputs(
      [videoInput('prompt', 'prompt', 0, 'text'), videoInput('audio', 'audioTrack', 1, 'audio', 2)],
      { modelAlias: 'seedance2.0-9-3-3-PT', videoMode: 'omni_reference' },
    );
    expect(audioOnly.issues).toEqual([]);

    for (const sourceDurationSeconds of [31, Number.NaN, Number.POSITIVE_INFINITY]) {
      const invalidDuration = precheckVideoGenerationInputs(
        [
          videoInput('prompt', 'prompt', 0, 'text'),
          videoInput('audio', 'audioTrack', 1, 'audio', sourceDurationSeconds),
        ],
        { modelAlias: 'seedance2.0-9-3-3-PT', videoMode: 'omni_reference' },
      );
      expect(invalidDuration.issues).toContainEqual({
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        role: 'audioTrack',
        message: 'seedance2.0-9-3-3-PT 的参考音频需要冻结 2 到 30 秒时长',
      });
    }

    const frameMix = precheckVideoGenerationInputs(
      [videoInput('first', 'firstFrame', 0), videoInput('reference', 'referenceImage', 1)],
      { modelAlias: 'seedance2.0-9-3-3-PT' },
    );
    expect(frameMix.issues).toEqual([
      {
        code: 'UNSUPPORTED_INPUT_COMBINATION',
        message: '首帧或尾帧不能与其它参考素材混用',
      },
    ]);

    const frameOnly = precheckVideoGenerationInputs(
      [videoInput('first', 'firstFrame', 0), videoInput('last', 'lastFrame', 1)],
      { modelAlias: 'seedance2.0-9-3-3-PT' },
    );
    expect(frameOnly.issues).toEqual([]);
  });
});

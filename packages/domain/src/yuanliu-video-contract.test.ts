import { describe, expect, it } from 'vitest';
import {
  canvasDocumentSchema,
  confirmedVideoInputRolesForModel,
  isUnadaptedYuanliuVideoModel,
  precheckVideoGenerationInputs,
  resolveYuanliuVideoParameters,
  videoFamilyForModel,
  videoInputRoleForPromptMention,
  videoModeCapability,
  yuanliuVideoContractForModel,
  yuanliuVideoModelAliases,
  YuanliuVideoParameterError,
  type MediaType,
  type PortRole,
  type RunInputSnapshot,
} from './index.js';

/** 精确别名与上游 ID 的已确认差异；不以相似模型名共享能力。 */
const models = [
  ['Yuan-Seedance-2.5-Official', 'seedance-2.5-guanfang-anmiao', 4, 30, 30, 0, 10, 40],
  ['Yuan-Seedance-2.0-LJ', 'yl_g7zy_seedance_v2_0_std', 4, 15, 9, 0, 0, 9],
  ['Yuan-Seedance-2.0-LJ-Full', 'yl_g7zy_seedance_v2_0_std_full', 5, 15, 9, 3, 3, 15],
  ['Yuan-Seedance-2.5-LJ', 'yl_g7zy_seedance_v2_5', 4, 30, 30, 0, 0, 30],
  ['Yuan-Seedance-2.5-LJ-Full', 'yl_g7zy_seedance_v2_5_full', 5, 30, 30, 10, 10, 40],
  ['Yuan-Seedance-2.0-HD', 'yl_seedance-2-0_ba0687ff09f2', 5, 15, 9, 0, 0, 9],
  ['Yuan-Seedance-2.5-HD', 'yl_seedance-2-5_6caffaca7390', 4, 30, 30, 0, 0, 30],
  ['Yuan-Seedance-2.5-HD-Full', 'yl_seedance-2-5_0fab2f1b1f10', 10, 30, 30, 10, 10, 40],
  ['Yuan-Seedance-2.5-HD-PerSecond', 'yl_seedance-2-5_750271498003', 10, 30, 30, 10, 10, 40],
  [
    'Yuan-Seedance-2.5-YS-Full',
    'yl_api_hmstudio_seedance_v2_5_101010_7d58bbb217e6',
    4,
    30,
    10,
    10,
    10,
    30,
  ],
  ['Yuan-Seedance-2.5-YS', 'yl_api_hmstudio_seedance_v2_5_dc729300ff39', 4, 30, 10, 0, 0, 10],
  ['Yuan-Seedance-2.5-YL1', 'yl_video-30_76dbb7993f8e', 30, 30, 9, 0, 0, 9],
  ['Yuan-Seedance-2.0-YS', 'yl_api_hmstudio_seedance_v2_0_514a65db713b', 4, 15, 9, 0, 0, 9],
] as const;

/** 构造有序普通参考或冻结文字，不读取用户素材和外部地址。 */
function reference(
  id: string,
  role: PortRole = 'referenceImage',
  mediaType: MediaType = 'image',
  sortOrder = 0,
): RunInputSnapshot {
  return {
    nodeId: id,
    role,
    sortOrder,
    snapshot: {
      id,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: id,
        mediaType,
        mode: 'source',
        contentUrl: `https://assets.invalid/${id}`,
      },
    },
  };
}

describe('源流精确视频合同', () => {
  it.each(models)(
    '%s 的别名和上游 ID 使用相同参数、分类参考及普通参考模式',
    (alias, upstream, min, max, images, videos, audios, total) => {
      const contract = yuanliuVideoContractForModel(alias)!;
      expect(yuanliuVideoContractForModel(` ${upstream} `)).toBe(contract);
      expect(contract).toMatchObject({
        modelAlias: alias,
        upstreamModel: upstream,
        duration: { min, max, default: Math.max(min, 5) },
        referenceLimits: { images, videos, audios, total },
        requiresPrompt: true,
      });
      expect(videoFamilyForModel(alias)).toBe('yuanliu');
      expect(videoFamilyForModel(upstream)).toBe('yuanliu');
      expect(confirmedVideoInputRolesForModel(alias)).not.toContain('firstFrame');
      expect(confirmedVideoInputRolesForModel(alias)).not.toContain('lastFrame');
      expect(videoModeCapability('text_to_video', alias)).toEqual({
        selectable: true,
        livePost: true,
        roles: ['prompt'],
      });
      expect(videoModeCapability('omni_reference', alias)).toMatchObject({
        selectable: true,
        livePost: true,
        roles: contract.confirmedInputRoles,
      });
      expect(videoInputRoleForPromptMention('image', 'text_to_video', alias)).toBe(
        'referenceImage',
      );
      expect(videoInputRoleForPromptMention('video', 'omni_reference', alias)).toBe(
        videos ? 'content' : undefined,
      );
      expect(videoInputRoleForPromptMention('audio', 'omni_reference', alias)).toBe(
        audios ? 'audioTrack' : undefined,
      );
      for (const duration of [min, max]) {
        expect(resolveYuanliuVideoParameters({ duration }, alias)).toEqual({
          seconds: duration,
          resolution: '720p',
          aspectRatio: '16:9',
        });
      }
      for (const duration of [min - 1, max + 1, -1]) {
        expect(() => resolveYuanliuVideoParameters({ duration }, alias)).toThrow(
          YuanliuVideoParameterError,
        );
      }
      for (const mode of [
        'first_frame',
        'first_last_frame',
        'video_edit',
        'video_extend',
      ] as const) {
        expect(videoModeCapability(mode, alias)).toMatchObject({
          selectable: false,
          livePost: false,
        });
      }
    },
  );

  it('未适配目录名称、大小写和对象属性不能借用源流合同', () => {
    expect(yuanliuVideoModelAliases).toEqual(models.map(([alias]) => alias));
    for (const [model, unadaptedYuanliu] of [
      ['Yuan-Seedance-2.5-LW', true],
      ['Yuan-Seedance-2.5-LJ-Full-v2', true],
      ['yuan-seedance-2.5-lj-full', true],
      ['Yuan-Unknown', true],
      ['Yuan-Kling-2.0', true],
      ['yuan-new-model', true],
      ['seedance-2.5-guanfang-anmiao-v2', true],
      ['constructor', false],
      ['__proto__', false],
    ] as const) {
      expect(yuanliuVideoContractForModel(model)).toBeUndefined();
      expect(videoFamilyForModel(model)).toBe('unknown');
      expect(isUnadaptedYuanliuVideoModel(model)).toBe(unadaptedYuanliu);
      expect(() => resolveYuanliuVideoParameters({ duration: 5 }, model)).toThrow(
        YuanliuVideoParameterError,
      );
      if (unadaptedYuanliu) {
        for (const mode of [undefined, 'text_to_video', 'first_frame', 'omni_reference'] as const) {
          expect(
            precheckVideoGenerationInputs([], {
              modelAlias: model,
              videoMode: mode,
              parameters: { duration: 5, prompt: 'A quiet room.' },
            }).issues,
          ).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION' }));
          if (mode) expect(videoModeCapability(mode, model).selectable).toBe(false);
        }
      }
    }
    expect(videoFamilyForModel('doubao-seedance-2-0-260128')).toBe('seedance-2');
    expect(videoFamilyForModel('Seedance2.0 0.9r')).toBe('image2pro');
  });

  it('按精确型号验证离散时长、比例和清晰度，不推断相邻型号', () => {
    for (const duration of [5, 10, 15]) {
      expect(resolveYuanliuVideoParameters({ duration }, 'Yuan-Seedance-2.0-HD').seconds).toBe(
        duration,
      );
    }
    expect(() => resolveYuanliuVideoParameters({ duration: 6 }, 'Yuan-Seedance-2.0-HD')).toThrow();
    expect(() =>
      resolveYuanliuVideoParameters({ duration: 29 }, 'Yuan-Seedance-2.5-YL1'),
    ).toThrow();
    for (const resolution of ['480p', '720p', '1080p']) {
      expect(
        resolveYuanliuVideoParameters(
          { duration: 4, resolution, ratio: 'adaptive' },
          'Yuan-Seedance-2.5-Official',
        ),
      ).toEqual({
        seconds: 4,
        resolution,
        aspectRatio: 'adaptive',
      });
    }
    expect(() =>
      resolveYuanliuVideoParameters({ duration: 5, resolution: '1080p' }, 'Yuan-Seedance-2.5-LJ'),
    ).toThrow();
    expect(() =>
      resolveYuanliuVideoParameters({ duration: 5, ratio: 'adaptive' }, 'Yuan-Seedance-2.5-LJ'),
    ).toThrow();
    expect(() =>
      resolveYuanliuVideoParameters({ duration: 5, ratio: 'auto' }, 'Yuan-Seedance-2.5-HD'),
    ).toThrow();
    expect(() =>
      resolveYuanliuVideoParameters({ duration: 5, ratio: 'auto' }, 'Yuan-Seedance-2.5-YS'),
    ).toThrow();
    expect(
      resolveYuanliuVideoParameters({ duration: 5, ratio: 'auto' }, 'Yuan-Seedance-2.5-LJ')
        .aspectRatio,
    ).toBe('auto');
  });

  it.each([
    {},
    { duration: 0 },
    { duration: 4 },
    { duration: 5.5 },
    { duration: 31 },
    { duration: '5.00' },
    { duration: ' 5' },
    { duration: true },
    { duration: null },
    { duration: Infinity },
    { duration: 5, seconds: 6 },
    { duration: 5, resolution: '720p', size: '1080p' },
    { duration: 5, aspectRatio: '16:9', ratio: '9:16' },
    { duration: 5, aspectRatio: '' },
    { duration: 5, prompt: 123 },
  ])('非法参数或冲突别名 %# 明确失败', (parameters) => {
    expect(() => resolveYuanliuVideoParameters(parameters, 'Yuan-Seedance-2.5-LJ-Full')).toThrow(
      YuanliuVideoParameterError,
    );
  });

  it('同义字段归一后相同可接受，输入对象保持不变', () => {
    const parameters = Object.freeze({
      duration: 5,
      seconds: '5',
      durationSeconds: 5,
      videoResolution: '720P',
      size: '720p',
      ratio: '9:16',
      aspectRatio: '9:16',
    });
    expect(resolveYuanliuVideoParameters(parameters, 'Yuan-Seedance-2.5-LJ-Full')).toEqual({
      seconds: 5,
      resolution: '720p',
      aspectRatio: '9:16',
    });
    expect(parameters.seconds).toBe('5');
  });

  it.each([
    'quality',
    'seed',
    'images',
    'input_reference',
    'watermark',
    'generate_audio',
    'inferenceStrength',
    'mode',
    'metadata',
  ])('未适配参数 %s 不静默删除', (field) => {
    const parameters = { duration: 5, [field]: 'retained' };
    expect(() => resolveYuanliuVideoParameters(parameters, 'Yuan-Seedance-2.5-LJ-Full')).toThrow(
      `源流视频参数 ${field} 尚不支持，请明确移除后重试`,
    );
    expect(parameters[field]).toBe('retained');
  });

  it('按 Unicode 字符计算 prompt 上限，正文不能为空，编号不能超出各类参考', () => {
    const options = {
      modelAlias: 'Yuan-Seedance-2.5-YL1',
      parameters: { duration: 30, prompt: '\u{1f642}'.repeat(8_000) },
    };
    expect(precheckVideoGenerationInputs([], options).issues).toEqual([]);
    for (const prompt of ['', ' ', '\u{1f642}'.repeat(8_001), '@Image1', '@Video1', '@Audio0']) {
      expect(
        precheckVideoGenerationInputs([], { ...options, parameters: { duration: 30, prompt } })
          .issues,
      ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    }
    const inputs = [
      reference('a'),
      reference('a'),
      reference('video', 'content', 'video'),
      reference('audio', 'audioTrack', 'audio'),
    ];
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
        videoMode: 'omni_reference',
        parameters: { duration: 5, prompt: '@Image2 @Video1 @Audio1' },
      }).issues,
    ).toEqual([]);
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
        parameters: { duration: 5, prompt: '@Image3' },
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
  });

  it.each(models)(
    '%s 的分类与总数上限适用于重复素材',
    (alias, _upstream, min, _max, images, videos, audios, total) => {
      const options = {
        modelAlias: alias,
        parameters: { duration: min, prompt: 'Follow the references.' },
        videoMode: 'omni_reference' as const,
      };
      for (const [role, mediaType, limit] of [
        ['referenceImage', 'image', images],
        ['content', 'video', videos],
        ['audioTrack', 'audio', audios],
      ] as const) {
        const inputs = Array.from({ length: limit + 1 }, (_, sortOrder) =>
          reference('same', role, mediaType, sortOrder),
        );
        expect(precheckVideoGenerationInputs(inputs, options).issues).toContainEqual(
          expect.objectContaining({ code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED', role }),
        );
      }
      const accepted = [
        ...Array.from({ length: images }, (_, n) =>
          reference(`image-${n}`, 'referenceImage', 'image', n),
        ),
        ...Array.from({ length: videos }, (_, n) =>
          reference(`video-${n}`, 'content', 'video', images + n),
        ),
        ...Array.from({ length: audios }, (_, n) =>
          reference(`audio-${n}`, 'audioTrack', 'audio', images + videos + n),
        ),
      ];
      expect(precheckVideoGenerationInputs(accepted.slice(0, total), options).issues).toEqual([]);
      if (accepted.length > total)
        expect(precheckVideoGenerationInputs(accepted, options).issues).toContainEqual(
          expect.objectContaining({
            code: 'UNSUPPORTED_INPUT_COMBINATION',
            message: `源流 参考素材总数不能超过 ${total}`,
          }),
        );
    },
  );

  it('旧无模式 content 图片和音频按普通参考收集，显式首尾帧仍拒绝', () => {
    const options = {
      modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
      parameters: { duration: 5, prompt: 'Use the references.' },
    };
    const inputs = [
      reference('late', 'content', 'image', 2),
      reference('early', 'content', 'image', 1),
      reference('audio', 'content', 'audio', 3),
    ];
    const result = precheckVideoGenerationInputs(inputs, options);
    expect(result.issues).toEqual([]);
    expect(result.inputSet.referenceImage.map(({ nodeId }) => nodeId)).toEqual(['early', 'late']);
    expect(result.inputSet.firstFrame).toBeUndefined();
    expect(result.inputSet.audioTrack).toHaveLength(1);
    for (const role of [
      'firstFrame',
      'lastFrame',
      'negativePrompt',
      'transcript',
      'mask',
    ] as const) {
      expect(
        precheckVideoGenerationInputs([reference('unsupported', role)], options).issues,
      ).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_INPUT_ROLE', role }));
    }
    expect(
      precheckVideoGenerationInputs([reference('mismatch', 'referenceImage', 'video')], options)
        .issues,
    ).toContainEqual(
      expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION', role: 'referenceImage' }),
    );
  });

  it('仅已验证且明确冻结版本的文字可以在 API 延后读取，Provider 仍需实际正文', () => {
    const text = reference('text', 'content', 'text');
    text.sourceAssetId = 'text';
    text.sourceAssetVersion = 2;
    text.snapshot.data.assetId = 'text';
    text.snapshot.data.contentUrl = '/v1/assets/text/versions/2/content';
    const options = {
      modelAlias: 'Yuan-Seedance-2.5-LJ',
      parameters: { duration: 5 },
      allowUnresolvedFrozenTextInput: true,
    };
    expect(precheckVideoGenerationInputs([text], options).issues).toEqual([]);
    expect(
      precheckVideoGenerationInputs([text], { ...options, allowUnresolvedFrozenTextInput: false })
        .issues,
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    text.snapshot.data.contentUrl = '/v1/assets/text/versions/3/content';
    expect(precheckVideoGenerationInputs([text], options).issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }),
    );
  });

  it('持久化保留精确型号、显式参数、重复参考与 40 项边界，不修正非法旧参数', () => {
    const parameters = { duration: 30, quality: 'high', ratio: '9:16' };
    const node = {
      id: 'video',
      type: 'video',
      position: { x: 0, y: 0 },
      data: {
        label: 'video',
        mediaType: 'video',
        mode: 'generate',
        modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
        parameters,
        resourceRefs: Array.from({ length: 40 }, (_, n) => ({
          id: `ref-${n}`,
          assetId: 'same',
          assetVersion: 2,
          mediaType: 'image',
          name: `reference-${n}`,
        })),
      },
    };
    const document = canvasDocumentSchema.parse({ revision: 1, nodes: [node], edges: [] });
    expect(document.nodes[0]!.data).toMatchObject({
      modelAlias: 'Yuan-Seedance-2.5-LJ-Full',
      parameters,
      resourceRefs: node.data.resourceRefs,
    });
    expect(
      canvasDocumentSchema.safeParse({
        revision: 1,
        nodes: [
          {
            ...node,
            data: {
              ...node.data,
              resourceRefs: [
                ...node.data.resourceRefs,
                { ...node.data.resourceRefs[0], id: 'ref-40' },
              ],
            },
          },
        ],
        edges: [],
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  canvasDocumentSchema,
  image2proVideoContractForModel,
  image2proVideoModelAliases,
  Image2proVideoParameterError,
  isRetiredImage2proVideoModel,
  retiredImage2proVideoModelReason,
  precheckVideoGenerationInputs,
  resolveImage2proVideoParameters,
  videoFamilyForModel,
  videoInputRoleForPromptMention,
  videoModeCapability,
  type MediaType,
  type PortRole,
  type RunInputSnapshot,
} from './index';

/** 构造带明确角色和排序的冻结来源；测试不读取真实素材。 */
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
        contentUrl: `https://assets.example/${id}`,
      },
    },
  };
}

describe('Image2Pro video contract', () => {
  it('只识别已确认的精确模型 ID，不借用官方 Seedance 或相似名称的能力', () => {
    expect(image2proVideoModelAliases).toEqual(['Seedance2.0 0.9r', '无限制-Flash-MAX-Video']);
    for (const modelAlias of image2proVideoModelAliases) {
      expect(image2proVideoContractForModel(modelAlias)).toMatchObject({
        modelAlias,
        family: 'image2pro',
        referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
      });
      expect(videoFamilyForModel(modelAlias)).toBe('image2pro');
    }
    for (const modelAlias of [
      '无限制-flash-MAX-Video',
      '无限制-Flash-MAX-Video-v2',
      'seedance2.0 0.9r',
      'doubao-seedance-2-0-260128',
      '__proto__',
      'constructor',
    ]) {
      expect(image2proVideoContractForModel(modelAlias)).toBeUndefined();
    }
    expect(videoFamilyForModel('doubao-seedance-2-0-260128')).toBe('seedance-2');
  });

  it.each(['无限制-Flash-中配-Video'])(
    '%s 停止新生成，旧参数和未写模式的画布也不借用通用能力',
    (modelAlias) => {
      expect(isRetiredImage2proVideoModel(` ${modelAlias} `)).toBe(true);
      expect(image2proVideoContractForModel(modelAlias)).toBeUndefined();
      expect(videoFamilyForModel(modelAlias)).toBe('unknown');
      for (const videoMode of [
        undefined,
        'text_to_video',
        'first_frame',
        'first_last_frame',
        'omni_reference',
        'video_edit',
        'video_extend',
      ] as const) {
        if (videoMode) {
          expect(videoModeCapability(videoMode, modelAlias)).toMatchObject({
            selectable: false,
            livePost: false,
          });
        }
        expect(
          precheckVideoGenerationInputs([], { modelAlias, videoMode, parameters: { duration: 5 } })
            .issues,
        ).toContainEqual({
          code: 'UNSUPPORTED_INPUT_COMBINATION',
          message: retiredImage2proVideoModelReason,
        });
      }
    },
  );

  it.each(image2proVideoModelAliases)(
    '%s 开放官方首尾帧与多媒体参考，编辑延长仍关闭',
    (modelAlias) => {
      expect(videoModeCapability('text_to_video', modelAlias)).toEqual({
        selectable: true,
        livePost: true,
        roles: ['prompt'],
      });
      expect(videoModeCapability('omni_reference', modelAlias)).toMatchObject({
        selectable: true,
        livePost: true,
        roles: ['prompt', 'referenceImage', 'content', 'audioTrack', 'character', 'style'],
        repeatableRoles: expect.arrayContaining([
          'referenceImage',
          'character',
          'style',
          'content',
          'audioTrack',
        ]),
      });
      for (const mode of ['video_edit', 'video_extend'] as const) {
        expect(videoModeCapability(mode, modelAlias)).toMatchObject({
          selectable: false,
          livePost: false,
        });
      }
      expect(videoInputRoleForPromptMention('image', 'text_to_video', modelAlias)).toBe(
        'referenceImage',
      );
      expect(videoModeCapability('first_frame', modelAlias)).toMatchObject({
        livePost: true,
        requiredRoles: ['firstFrame'],
      });
      expect(videoModeCapability('first_last_frame', modelAlias)).toMatchObject({
        livePost: true,
        requiredRoles: ['firstFrame', 'lastFrame'],
      });
      expect(videoInputRoleForPromptMention('audio', 'omni_reference', modelAlias)).toBe(
        'audioTrack',
      );
      expect(videoInputRoleForPromptMention('video', 'omni_reference', modelAlias)).toBe('content');
    },
  );

  it('合并计数普通图片角色，保持稳定排序，并在第十张图拒绝', () => {
    const inputs = Array.from({ length: 9 }, (_, index) =>
      reference(`image-${index}`, index === 0 ? 'character' : 'referenceImage', 'image', 9 - index),
    );
    const options = {
      modelAlias: 'Seedance2.0 0.9r',
      videoMode: 'omni_reference' as const,
      parameters: { duration: 5 },
    };
    const result = precheckVideoGenerationInputs(inputs, options);
    expect(result.issues).toEqual([]);
    expect(result.inputSet.firstFrame).toBeUndefined();
    expect(result.inputSet.referenceImage.map((input) => input.nodeId)).toEqual([
      'image-8',
      'image-7',
      'image-6',
      'image-5',
      'image-4',
      'image-3',
      'image-2',
      'image-1',
    ]);
    expect(
      precheckVideoGenerationInputs([...inputs, reference('tenth', 'style')], options).issues,
    ).toContainEqual({
      code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED',
      role: 'referenceImage',
      message: 'Image2Pro 参考图数量超过模型上限 9',
    });
  });

  it('全能参考模式不隐式接受首尾帧角色', () => {
    for (const role of ['firstFrame', 'lastFrame'] as const) {
      expect(
        precheckVideoGenerationInputs([reference(role, role)], {
          modelAlias: 'Seedance2.0 0.9r',
          videoMode: 'omni_reference',
          parameters: { duration: 5 },
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_INPUT_ROLE', role }));
    }
  });

  it.each(['--duration 15', 'A scene --rt 21:9', 'A scene\n--WM false', '--seed 7'])(
    '拒绝提示词覆盖显式参数：%s',
    (prompt) => {
      expect(() => resolveImage2proVideoParameters({ duration: 5, prompt })).toThrow(
        Image2proVideoParameterError,
      );
      expect(
        precheckVideoGenerationInputs([], {
          modelAlias: 'Seedance2.0 0.9r',
          videoMode: 'text_to_video',
          parameters: { duration: 5, prompt },
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    },
  );

  it('旧画布未写模式时，content 图片仍为普通参考图，不误映射首帧', () => {
    const result = precheckVideoGenerationInputs([reference('legacy-image', 'content')], {
      modelAlias: 'Seedance2.0 0.9r',
      parameters: { seconds: '5' },
    });
    expect(result.issues).toEqual([]);
    expect(result.operation).toBe('reference_guided');
    expect(result.inputSet.firstFrame).toBeUndefined();
    expect(result.inputSet.referenceImage.map((input) => input.nodeId)).toEqual(['legacy-image']);
  });

  it.each([
    ['negativePrompt', 'text'],
    ['audioTrack', 'video'],
    ['referenceImage', 'video'],
  ] as const)('显式或旧模式都拒绝未经确认的 %s/%s 输入', (role, mediaType) => {
    for (const videoMode of [undefined, 'omni_reference'] as const) {
      const result = precheckVideoGenerationInputs([reference('unsupported', role, mediaType)], {
        modelAlias: 'Seedance2.0 0.9r',
        videoMode,
        parameters: { duration: 5 },
      });
      expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ role })]));
    }
  });

  it('历史通用 content 音频按参考音频收集，并继续拒绝纯音频', () => {
    const options = { modelAlias: 'Seedance2.0 0.9r', parameters: { duration: 5 } };
    expect(
      precheckVideoGenerationInputs(
        [reference('image'), reference('audio', 'content', 'audio')],
        options,
      ).issues,
    ).toEqual([]);
    expect(
      precheckVideoGenerationInputs([reference('audio', 'content', 'audio')], options).issues,
    ).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION' }));
  });

  it('保留不支持的旧参数并在预检明确失败，持久化不删字段', () => {
    const parameters = { duration: 5, resolution: '720p', quality: 'high' };
    const document = canvasDocumentSchema.parse({
      revision: 1,
      nodes: [
        {
          id: 'video',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: 'video',
            mediaType: 'video',
            mode: 'generate',
            modelAlias: 'Seedance2.0 0.9r',
            videoMode: 'omni_reference',
            parameters,
          },
        },
      ],
      edges: [],
    });
    expect(document.nodes[0]!.data.parameters).toEqual(parameters);
    const result = precheckVideoGenerationInputs([reference('image')], {
      modelAlias: 'Seedance2.0 0.9r',
      videoMode: 'omni_reference',
      parameters,
    });
    expect(result.issues).toContainEqual({
      code: 'UNSUPPORTED_PROVIDER_PARAMETER',
      message: 'Image2Pro 视频参数 quality 尚不支持，请明确移除后重试',
    });
    expect(parameters).toEqual({ duration: 5, resolution: '720p', quality: 'high' });
  });
});

describe('Image2Pro Flash-MAX H3 合同', () => {
  const modelAlias = '无限制-Flash-MAX-Video';
  const options = {
    modelAlias,
    videoMode: 'omni_reference' as const,
    parameters: { duration: 5, prompt: 'Follow the reference sound.', ratio: 'adaptive' },
  };

  it('网关分辨率和输出时长独立于 native H3 与 Seedance，不改写模型或旧参数', () => {
    expect(isRetiredImage2proVideoModel(modelAlias)).toBe(false);
    const contract = image2proVideoContractForModel(modelAlias)!;
    expect(contract).toMatchObject({
      duration: { min: 4, max: 12, default: 5 },
      resolutions: ['720p'],
      maxPromptLength: 7000,
      requiresPrompt: true,
      allowsAudioOnlyReference: true,
      requiresAdaptiveFrameRatio: true,
      supportsVideoDataUrl: true,
    });
    expect(contract.parameterKeys).not.toEqual(
      expect.arrayContaining(['generate_audio', 'watermark', 'return_last_frame']),
    );
    for (let duration = 4; duration <= 12; duration += 1) {
      const parameters = Object.freeze({ duration, resolution: '720P' });
      expect(resolveImage2proVideoParameters(parameters, modelAlias)).toEqual({
        seconds: duration,
        resolution: '720p',
      });
      expect(parameters.resolution).toBe('720P');
    }
    expect(() => resolveImage2proVideoParameters({ duration: 5 }, '未知-Flash-MAX')).toThrow(
      '尚不支持此精确型号',
    );
  });

  it('H3 提示词按普通文字保留，不套用 Seedance 的 inline 参数语法', () => {
    expect(
      resolveImage2proVideoParameters(
        { duration: 5, prompt: 'Write --duration 15 on the sign.' },
        modelAlias,
      ),
    ).toMatchObject({ seconds: 5 });
  });

  it('只有受授权的明确冻结文字来源可延后正文校验，缺少身份或版本不能冒用例外', () => {
    const text = reference('text', 'prompt', 'text');
    text.sourceAssetId = 'asset-text';
    text.sourceAssetVersion = 1;
    text.snapshot.data.assetId = 'asset-text';
    text.snapshot.data.contentUrl = '/v1/assets/asset-text/versions/1/content';
    const checkOptions = {
      modelAlias,
      videoMode: 'text_to_video' as const,
      parameters: { duration: 5 },
    };
    expect(precheckVideoGenerationInputs([text], checkOptions).issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }),
    );
    expect(
      precheckVideoGenerationInputs([text], {
        ...checkOptions,
        allowUnresolvedFrozenTextInput: true,
      }).issues,
    ).toEqual([]);
    for (const changed of [
      { ...text, sourceAssetId: undefined },
      { ...text, sourceAssetVersion: undefined },
      { ...text, sourceAssetVersion: 2 },
      {
        ...text,
        snapshot: { ...text.snapshot, data: { ...text.snapshot.data, assetId: 'other' } },
      },
      {
        ...text,
        snapshot: {
          ...text.snapshot,
          data: { ...text.snapshot.data, contentUrl: 'https://assets.example/untrusted.txt' },
        },
      },
    ]) {
      expect(
        precheckVideoGenerationInputs([changed], {
          ...checkOptions,
          allowUnresolvedFrozenTextInput: true,
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    }
  });

  it.each([
    { duration: 3 },
    { duration: 13 },
    { duration: 15 },
    { duration: 5.5 },
    { duration: 5, resolution: '768p' },
    { duration: 5, resolution: '1080p' },
    { duration: 5, resolution: '4k' },
    { duration: 5, generate_audio: false },
    { duration: 5, watermark: false },
    { duration: 5, return_last_frame: false },
    { duration: 5, unknown: true },
    { duration: 5, prompt: 'x'.repeat(7001) },
  ])('拒绝型号独立边界与不支持参数 %#', (parameters) => {
    expect(() => resolveImage2proVideoParameters(parameters, modelAlias)).toThrow(
      Image2proVideoParameterError,
    );
  });

  it('纯音频参考及其 adaptive 比例有效，按类别检查冻结时长和数量', () => {
    const audio = reference('audio', 'audioTrack', 'audio');
    expect(precheckVideoGenerationInputs([audio], options).issues).toEqual([]);
    expect(
      precheckVideoGenerationInputs([{ ...audio, sourceDurationSeconds: 15 }], options).issues,
    ).toEqual([]);
    for (const durations of [[1.9], [15.1], [8, 8]]) {
      expect(
        precheckVideoGenerationInputs(
          durations.map((sourceDurationSeconds, index) => ({
            ...reference(`audio-${index}`, 'audioTrack', 'audio', index),
            sourceDurationSeconds,
          })),
          options,
        ).issues,
      ).toContainEqual(expect.objectContaining({ role: 'audioTrack' }));
    }
    expect(
      precheckVideoGenerationInputs(
        Array.from({ length: 4 }, (_, index) =>
          reference(`audio-${index}`, 'audioTrack', 'audio', index),
        ),
        options,
      ).issues,
    ).toContainEqual(expect.objectContaining({ code: 'INPUT_ROLE_CARDINALITY_UNSUPPORTED' }));
  });

  it('文生不能 adaptive，帧只允许 adaptive，所有模式必须提供非空提示词', () => {
    const first = reference('first', 'firstFrame');
    for (const ratio of [undefined, 'adaptive']) {
      expect(
        precheckVideoGenerationInputs([first], {
          ...options,
          videoMode: 'first_frame',
          parameters: { duration: 5, prompt: 'Animate this frame.', ratio },
        }).issues,
      ).toEqual([]);
    }
    expect(
      precheckVideoGenerationInputs([first], {
        ...options,
        videoMode: 'first_frame',
        parameters: { duration: 5, prompt: 'Animate this frame.', ratio: '16:9' },
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    expect(
      precheckVideoGenerationInputs([], { ...options, videoMode: 'text_to_video' }).issues,
    ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    for (const prompt of [undefined, '', '   ']) {
      expect(
        precheckVideoGenerationInputs([reference('image')], {
          ...options,
          parameters: { duration: 5, prompt },
        }).issues,
      ).toContainEqual(expect.objectContaining({ code: 'INVALID_PROVIDER_PARAMETER' }));
    }
  });
});

describe('Image2Pro video parameters', () => {
  it('固定整数时长兼容一致的历史别名，且不改写输入', () => {
    const parameters = Object.freeze({
      duration: 5,
      seconds: '5.00',
      durationSeconds: '5',
      aspectRatio: '9:16',
      aspect_ratio: '9:16',
      ratio: '9:16',
    });
    expect(resolveImage2proVideoParameters(parameters)).toEqual({
      seconds: 5,
      resolution: '720p',
      aspectRatio: '9:16',
    });
    expect(parameters.duration).toBe(5);
    for (const duration of [4, 15])
      expect(resolveImage2proVideoParameters({ duration })).toMatchObject({ seconds: duration });
  });

  it.each([
    {},
    { duration: 0 },
    { duration: 3 },
    { duration: 5.5 },
    { duration: 16 },
    { duration: -1 },
    { duration: 3600.01 },
    { duration: Infinity },
    { duration: true },
    { duration: null },
    { duration: '1e2' },
    { duration: '' },
    { duration: 5, seconds: 6 },
    { duration: 5, aspectRatio: '' },
    { duration: 5, ratio: '   ' },
    { duration: 5, ratio: 1 },
    { duration: 5, ratio: '9:16\n' },
    { duration: 5, ratio: 'r'.repeat(65) },
    { duration: 5, aspectRatio: '9:16', ratio: '16:9' },
    { duration: 5, prompt: 'x'.repeat(30_001) },
    { duration: 5, resolution: '2k' },
    { duration: 5, resolution: '720p', videoResolution: '1080p' },
    { duration: 5, generate_audio: 'false' },
  ])('拒绝缺少时长、类型/边界错误及冲突别名 %#', (parameters) => {
    expect(() => resolveImage2proVideoParameters(parameters)).toThrow(Image2proVideoParameterError);
    try {
      resolveImage2proVideoParameters(parameters);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER' });
    }
  });

  it.each([
    'quality',
    'size',
    'seed',
    'images',
    'inferenceStrength',
    'camera_fixed',
    'output_format',
  ])('不会静默删除不支持的 %s 参数', (field) => {
    const parameters = { duration: 5, [field]: 'retained' };
    expect(() => resolveImage2proVideoParameters(parameters)).toThrow(
      `Image2Pro 视频参数 ${field} 尚不支持，请明确移除后重试`,
    );
    expect(parameters[field]).toBe('retained');
  });

  it('解析官方清晰度、比例与显式 false，不丢弃开关', () => {
    for (const resolution of ['480p', '720p', '1080p', '4k']) {
      for (const ratio of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']) {
        expect(
          resolveImage2proVideoParameters({
            duration: 8,
            resolution: resolution.toUpperCase(),
            ratio,
            generate_audio: false,
            watermark: false,
            return_last_frame: true,
          }),
        ).toEqual({
          seconds: 8,
          resolution,
          aspectRatio: ratio,
          generate_audio: false,
          watermark: false,
          return_last_frame: true,
        });
      }
    }
  });

  it('拒绝纯音频、超量视频音频，以及首尾帧与参考素材混用', () => {
    const options = {
      modelAlias: 'Seedance2.0 0.9r',
      videoMode: 'omni_reference' as const,
      parameters: { duration: 5 },
    };
    for (const inputs of [
      [reference('audio', 'audioTrack', 'audio')],
      [
        reference('image'),
        ...Array.from({ length: 4 }, (_, n) => reference(`video-${n}`, 'content', 'video')),
      ],
      [
        reference('image'),
        ...Array.from({ length: 4 }, (_, n) => reference(`audio-${n}`, 'audioTrack', 'audio')),
      ],
      [reference('first', 'firstFrame'), reference('image')],
    ])
      expect(precheckVideoGenerationInputs(inputs, options).issues.length).toBeGreaterThan(0);
    expect(
      precheckVideoGenerationInputs(
        [
          reference('image'),
          reference('video', 'content', 'video'),
          reference('audio', 'audioTrack', 'audio'),
        ],
        options,
      ).issues,
    ).toEqual([]);
  });

  it.each(['video', 'audio'] as const)(
    '验证冻结 %s 单段和类别累计时长，缺少元数据不阻断草稿',
    (mediaType) => {
      const role = mediaType === 'video' ? 'content' : 'audioTrack';
      const options = {
        modelAlias: 'Seedance2.0 0.9r',
        videoMode: 'omni_reference' as const,
        parameters: { duration: 5 },
      };
      const inputsFor = (durations: Array<number | undefined>) => [
        reference('image'),
        ...durations.map((sourceDurationSeconds, index) => ({
          ...reference(`media-${index}`, role, mediaType, index),
          ...(sourceDurationSeconds !== undefined ? { sourceDurationSeconds } : {}),
        })),
      ];
      for (const durations of [[2], [15], [2, 13], [7.5, 7.5], [undefined], [undefined, 15]]) {
        expect(precheckVideoGenerationInputs(inputsFor(durations), options).issues).toEqual([]);
      }
      for (const durations of [[1.99], [15.01], [Number.NaN], [8, 8]]) {
        expect(precheckVideoGenerationInputs(inputsFor(durations), options).issues).toContainEqual(
          expect.objectContaining({ code: 'UNSUPPORTED_INPUT_COMBINATION', role }),
        );
      }
    },
  );

  it('视频与音频各自累计，不把两类合法的 15 秒合成 30 秒拒绝', () => {
    const inputs = [
      reference('image'),
      { ...reference('video', 'content', 'video'), sourceDurationSeconds: 15 },
      { ...reference('audio', 'audioTrack', 'audio'), sourceDurationSeconds: 15 },
    ];
    expect(
      precheckVideoGenerationInputs(inputs, {
        modelAlias: 'Seedance2.0 0.9r',
        videoMode: 'omni_reference',
        parameters: { duration: 5 },
      }).issues,
    ).toEqual([]);
  });
});

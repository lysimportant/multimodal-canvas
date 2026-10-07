import { describe, expect, it } from 'vitest';

import {
  canvasDocumentSchema,
  image2proVideoContractForModel,
  image2proVideoModelAliases,
  Image2proVideoParameterError,
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
    expect(image2proVideoModelAliases).toEqual([
      '无限制-Flash-中配-Video',
      '无限制-Flash-MAX-Video',
      'Seedance2.0 0.9r',
    ]);
    for (const modelAlias of image2proVideoModelAliases) {
      expect(image2proVideoContractForModel(modelAlias)).toMatchObject({
        modelAlias,
        family: 'image2pro',
        referenceLimits: { images: 9, videos: 0, audios: 0, total: 9 },
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

  it.each(image2proVideoModelAliases)('%s 仅开放文生视频与普通图片参考', (modelAlias) => {
    expect(videoModeCapability('text_to_video', modelAlias)).toEqual({
      selectable: true,
      livePost: true,
      roles: ['prompt'],
    });
    expect(videoModeCapability('omni_reference', modelAlias)).toMatchObject({
      selectable: true,
      livePost: true,
      roles: ['prompt', 'referenceImage', 'character', 'style'],
      repeatableRoles: ['referenceImage', 'character', 'style'],
    });
    for (const mode of ['first_frame', 'first_last_frame', 'video_edit', 'video_extend'] as const) {
      expect(videoModeCapability(mode, modelAlias)).toMatchObject({
        selectable: false,
        livePost: false,
      });
    }
    expect(videoInputRoleForPromptMention('image', 'text_to_video', modelAlias)).toBe(
      'referenceImage',
    );
    expect(videoInputRoleForPromptMention('audio', 'omni_reference', modelAlias)).toBeUndefined();
    expect(videoInputRoleForPromptMention('video', 'omni_reference', modelAlias)).toBeUndefined();
  });

  it('合并计数普通图片角色，保持稳定排序，并在第十张图拒绝', () => {
    const inputs = Array.from({ length: 9 }, (_, index) =>
      reference(`image-${index}`, index === 0 ? 'character' : 'referenceImage', 'image', 9 - index),
    );
    const options = {
      modelAlias: '无限制-Flash-MAX-Video',
      videoMode: 'omni_reference' as const,
      parameters: { duration: 5.5 },
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
    ['firstFrame', 'image'],
    ['lastFrame', 'image'],
    ['negativePrompt', 'text'],
    ['audioTrack', 'audio'],
    ['content', 'video'],
    ['referenceImage', 'video'],
  ] as const)('显式或旧模式都拒绝未经确认的 %s/%s 输入', (role, mediaType) => {
    for (const videoMode of [undefined, 'omni_reference'] as const) {
      const result = precheckVideoGenerationInputs([reference('unsupported', role, mediaType)], {
        modelAlias: '无限制-Flash-MAX-Video',
        videoMode,
        parameters: { duration: 5 },
      });
      expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ role })]));
    }
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
            modelAlias: '无限制-Flash-MAX-Video',
            videoMode: 'omni_reference',
            parameters,
          },
        },
      ],
      edges: [],
    });
    expect(document.nodes[0]!.data.parameters).toEqual(parameters);
    const result = precheckVideoGenerationInputs([reference('image')], {
      modelAlias: '无限制-Flash-MAX-Video',
      videoMode: 'omni_reference',
      parameters,
    });
    expect(result.issues).toContainEqual({
      code: 'UNSUPPORTED_PROVIDER_PARAMETER',
      message: 'Image2Pro 视频参数 resolution 尚不支持，请明确移除后重试',
    });
    expect(parameters).toEqual({ duration: 5, resolution: '720p', quality: 'high' });
  });
});

describe('Image2Pro video parameters', () => {
  it('保留小数时长，兼容一致的历史别名，且不改写输入', () => {
    const parameters = Object.freeze({
      duration: 5.5,
      seconds: '5.50',
      durationSeconds: '5.5',
      aspectRatio: '9:16',
      aspect_ratio: '9:16',
      ratio: '9:16',
    });
    expect(resolveImage2proVideoParameters(parameters)).toEqual({
      seconds: 5.5,
      aspectRatio: '9:16',
    });
    expect(parameters.duration).toBe(5.5);
    expect(resolveImage2proVideoParameters({ seconds: 3600 })).toEqual({ seconds: 3600 });
    expect(resolveImage2proVideoParameters({ seconds: 0.25, ratio: ' 16:9 ' })).toEqual({
      seconds: 0.25,
      aspectRatio: ' 16:9 ',
    });
  });

  it.each([
    {},
    { duration: 0 },
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
  ])('拒绝缺少时长、类型/边界错误及冲突别名 %#', (parameters) => {
    expect(() => resolveImage2proVideoParameters(parameters)).toThrow(Image2proVideoParameterError);
    try {
      resolveImage2proVideoParameters(parameters);
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_PROVIDER_PARAMETER' });
    }
  });

  it.each(['resolution', 'quality', 'size', 'seed', 'images', 'inferenceStrength'])(
    '不会静默删除不支持的 %s 参数',
    (field) => {
      const parameters = { duration: 5, [field]: 'retained' };
      expect(() => resolveImage2proVideoParameters(parameters)).toThrow(
        `Image2Pro 视频参数 ${field} 尚不支持，请明确移除后重试`,
      );
      expect(parameters[field]).toBe('retained');
    },
  );
});

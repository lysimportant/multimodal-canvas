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

  it('合并计数普通图片角色，保持稳定排序并允许额外引用交给上游', () => {
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
    ).toEqual([]);
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
    expect(resolveImage2proVideoParameters({ duration: 5 }, '未知-Flash-MAX')).toMatchObject({
      seconds: 5,
    });
  });

  it('H3 提示词按普通文字保留，不套用 Seedance 的 inline 参数语法', () => {
    expect(
      resolveImage2proVideoParameters(
        { duration: 5, prompt: 'Write --duration 15 on the sign.' },
        modelAlias,
      ),
    ).toMatchObject({ seconds: 5 });
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

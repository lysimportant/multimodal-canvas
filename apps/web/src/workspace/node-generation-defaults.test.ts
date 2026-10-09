import { describe, expect, it } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import type { ModelEntry } from './contracts';
import { applyNodeGenerationDefaults, resolvePreviousOperationSeed } from './NodeQuickEditor';

/** 构造只包含模型目录声明的测试模型，不请求外部 Provider。 */
function model(
  mediaType: AssetFlowNode['data']['mediaType'],
  capabilities: Record<string, unknown> = {},
): ModelEntry {
  return { id: 'test-model', name: '测试模型', mediaTypes: [mediaType], capabilities };
}

/** 构造待初始化的节点数据，其他业务字段随默认值应用保持不变。 */
function data(mediaType: AssetFlowNode['data']['mediaType']): AssetFlowNode['data'] {
  return {
    label: '测试节点',
    mediaType,
    mode: 'generate',
    modelAlias: 'test-model',
    prompt: '测试提示词',
  };
}

describe('applyNodeGenerationDefaults', () => {
  it('新视频未选模型或目录缺项时也保存数字 10 秒，不只设置控件显示值', () => {
    for (const candidate of [undefined, model('video')]) {
      const original = data('video');
      const configured = applyNodeGenerationDefaults(original, candidate);
      expect(configured.parameters).toEqual({ duration: 10 });
      expect(JSON.parse(JSON.stringify(configured)).parameters.duration).toBe(10);
      expect(original.parameters).toBeUndefined();
    }
  });

  it.each([2, 4, 10, 30, 31])('已有视频时长 %s 秒不被新默认覆盖', (duration) => {
    const original = { ...data('video'), parameters: { duration, custom: true } };
    const configured = applyNodeGenerationDefaults(original, model('video'));
    expect(configured.parameters).toEqual(original.parameters);
  });

  it('新图片把目录 K 档和比例转换为官方像素尺寸，原生质量独立保存', () => {
    const configured = applyNodeGenerationDefaults(
      data('image'),
      model('image', {
        resolutions: ['2k', '4k'],
        quality: ['high', 'medium'],
        aspectRatios: ['9:16'],
      }),
    );
    expect(configured.parameters).toEqual({
      size: '1152x2048',
      quality: 'high',
    });
    expect(configured.parameters).not.toHaveProperty('resolution');
    expect(configured.parameters).not.toHaveProperty('aspectRatio');
  });

  it.each([
    { quality: '4k', aspectRatio: '9:16' },
    { image_quality: '4k', aspect_ratio: '9:16' },
    { size: '1536x1024', quality: 'high' },
    { resolution: '1536x1024', quality: 'high' },
  ])('显式切模型不会把新默认清晰度或比例加入历史尺寸 %j', (parameters) => {
    const original = { ...data('image'), parameters };
    const configured = applyNodeGenerationDefaults(
      original,
      model('image', { resolutions: ['1k'], quality: ['high'], aspectRatios: ['1:1'] }),
    );
    expect(configured.parameters).toEqual(parameters);
    expect(original.parameters).toEqual(parameters);
  });

  it('明确事务初始化媒体首项和 10 秒，目录不含 10 时不暗改成首项秒数', () => {
    const original = data('video');
    const configured = applyNodeGenerationDefaults(
      original,
      model('video', {
        video: {
          resolutions: ['360p', '720p', '1080p'],
          aspectRatios: ['1:1', '16:9', '9:16'],
          durations: [4, 8, 12],
          reasoning_effort: ['low', 'medium', 'high'],
        },
      }),
    );
    expect(configured).toMatchObject({
      prompt: original.prompt,
      parameters: { resolution: '360p', aspectRatio: '1:1', duration: 10 },
      inferenceStrength: 'high',
    });
    expect(JSON.parse(JSON.stringify(configured)).parameters.duration).toBe(10);
    expect(original.parameters).toBeUndefined();
  });

  it('跳过空项、重复项和目录禁用项，只把原生质量保存为 quality', () => {
    const configured = applyNodeGenerationDefaults(
      data('image'),
      model('image', {
        quality: [
          '',
          { value: 'low', disabled: true },
          'medium',
          'medium',
          { value: 'high', enabled: false },
          'ultra',
        ],
        aspectRatios: [{ value: '1:1', available: false }, '16:9'],
      }),
    );
    expect(configured.parameters).toEqual({ quality: 'medium' });
  });

  it('已有参数、未知字段与历史推理强度不被默认值覆盖', () => {
    const original = {
      ...data('video'),
      parameters: { resolution: 'legacy', width: 1920, custom: true },
      inferenceStrength: 'custom-effort',
    };
    const configured = applyNodeGenerationDefaults(
      original,
      model('video', {
        resolutions: ['480p', '720p'],
        durations: [4, 8],
        reasoning_effort: ['low', 'medium'],
      }),
    );
    expect(configured.parameters).toEqual({
      resolution: 'legacy',
      width: 1920,
      custom: true,
      duration: 10,
    });
    expect(configured.inferenceStrength).toBe('custom-effort');
    expect(original.parameters).toEqual({ resolution: 'legacy', width: 1920, custom: true });
  });

  it('缺失模型、不兼容媒体或未声明的媒体枚举不能使用旧菜单回退值', () => {
    for (const candidate of [undefined, model('image'), model('text')]) {
      expect(applyNodeGenerationDefaults(data('image'), candidate).parameters).toEqual({});
    }
    expect(
      applyNodeGenerationDefaults(
        data('image'),
        model('image', {
          quality: { type: 'string', default: 'high' },
          aspectRatios: [],
        }),
      ).parameters,
    ).toEqual({});
  });

  it('无效时长不成为默认值，宽高和连续数值不推算', () => {
    const configured = applyNodeGenerationDefaults(
      data('video'),
      model('video', {
        durations: ['invalid', -1, 0, 5.5, 10],
        width: { min: 1, max: 1920 },
      }),
    );
    expect(configured.parameters).toEqual({ duration: 10 });
  });

  it('切换 MiniMax-H3 时保留已保存自动时长与比例', () => {
    const original = {
      ...data('video'),
      modelAlias: 'MiniMax-H3',
      parameters: { duration: -1, aspectRatio: 'adaptive', custom: true },
    };
    const configured = applyNodeGenerationDefaults(original, {
      id: 'MiniMax-H3',
      name: 'MiniMax H3',
      mediaTypes: ['video'],
    });
    expect(configured.parameters).toEqual(original.parameters);
    expect(original.parameters).toEqual({
      duration: -1,
      aspectRatio: 'adaptive',
      custom: true,
    });
  });

  it('切换 Moon minimax-h3 文生模式不改写已保存自动参数', () => {
    const original = {
      ...data('video'),
      modelAlias: 'minimax-h3',
      videoMode: 'text_to_video' as const,
      parameters: { duration: -1, aspectRatio: 'adaptive', custom: true },
    };
    const configured = applyNodeGenerationDefaults(original, {
      id: 'minimax-h3',
      name: 'Moon MiniMax H3',
      mediaTypes: ['video'],
    });
    expect(configured.parameters).toEqual(original.parameters);
    expect(original.parameters).toEqual({
      duration: -1,
      aspectRatio: 'adaptive',
      custom: true,
    });
  });

  it('切换到 Wan3 时保留自动时长和 adaptive 比例', () => {
    const configured = applyNodeGenerationDefaults(
      {
        ...data('video'),
        modelAlias: 'wan3.0-video',
        parameters: { duration: -1, aspectRatio: 'adaptive' },
      },
      { id: 'wan3.0-video', name: 'Moon Wan3', mediaTypes: ['video'] },
    );
    expect(configured.parameters).toEqual({
      aspectRatio: 'adaptive',
      duration: -1,
    });
  });

  it.each(['doubao-seedance-2-5-260628', 'seedance-2-0-official'])(
    '%s 未设置时长时采用编辑默认 10 秒，不强制改为自动',
    (modelAlias) => {
      const configured = applyNodeGenerationDefaults(
        {
          ...data('video'),
          modelAlias,
          videoMode: 'video_edit',
          parameters: { aspectRatio: 'adaptive' },
        },
        { id: modelAlias, name: modelAlias, mediaTypes: ['video'] },
      );
      expect(configured.parameters?.duration).toBe(10);
      expect(configured.parameters?.aspectRatio).toBe('adaptive');
    },
  );

  it('音频仅初始化已确认格式的第一项，保留必填音色与连续语速的输入含义', () => {
    const configured = applyNodeGenerationDefaults(data('audio'), model('audio'));
    expect(configured.parameters).toEqual({ response_format: 'mp3' });
    expect(configured.parameters).not.toHaveProperty('voice');
    expect(configured.parameters).not.toHaveProperty('speed');
  });

  it('目录音频格式建议不限制通用格式默认值', () => {
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: ['mp3', 'wav'] },
        }),
      ).parameters,
    ).toEqual({ response_format: 'mp3' });
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: ['mp3'] },
        }),
      ).parameters,
    ).toEqual({ response_format: 'mp3' });
    expect(
      applyNodeGenerationDefaults(
        data('audio'),
        model('audio', {
          audio: { response_formats: [] },
        }),
      ).parameters,
    ).toEqual({ response_format: 'mp3' });
  });

  it('GPT 已确认推理档位使用 high，并保留单项目录的声明值', () => {
    expect(
      applyNodeGenerationDefaults(data('text'), { ...model('text'), id: 'gpt-5.6-sol' })
        .inferenceStrength,
    ).toBe('high');
    expect(
      applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: ['xhigh'] }))
        .inferenceStrength,
    ).toBe('xhigh');
    expect(
      applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: [] }))
        .inferenceStrength,
    ).toBeUndefined();
  });

  it('推理强度按 high、中文高标签、第一可用值依次回退', () => {
    for (const [options, expected] of [
      [[{ value: 'custom', label: '高' }, 'high'], 'high'],
      [['low', { value: 'deep', label: '高' }, 'max'], 'deep'],
      [[{ value: 'high', disabled: true }, 'low', 'max'], 'low'],
      [['xhigh', 'ultra'], 'xhigh'],
      [[], undefined],
    ] as const) {
      expect(
        applyNodeGenerationDefaults(data('text'), model('text', { reasoning_effort: options }))
          .inferenceStrength,
      ).toBe(expected);
    }
  });

  it('新建图片沿用时把历史 K 档规范为 size，且不修改源节点', () => {
    const previous = {
      id: 'node_old',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        ...data('image'),
        mode: 'generate',
        modelAlias: 'prev-model',
        credentialId: 'cred-1',
        parameters: { quality: '4k', aspectRatio: '9:16', providerOption: false },
        inferenceStrength: 'medium',
      },
    } as const;
    const seed = resolvePreviousOperationSeed([previous], 'image', 'generate');
    expect(seed).toEqual({
      modelAlias: 'prev-model',
      credentialId: 'cred-1',
      parameters: { size: '2160x3840', providerOption: false },
      inferenceStrength: 'medium',
    });
    const configured = applyNodeGenerationDefaults(
      { ...data('image'), ...seed },
      model('image', { quality: ['1k', '2k', '4k'], aspectRatios: ['1:1', '9:16'] }),
    );
    expect(configured.parameters).toEqual({ size: '2160x3840', providerOption: false });
    expect(previous.data.parameters).toEqual({
      quality: '4k',
      aspectRatio: '9:16',
      providerOption: false,
    });
  });

  it('目录文案是默认值时仍用实际档位计算像素', () => {
    const configured = applyNodeGenerationDefaults(
      data('image'),
      model('image', {
        quality: [
          { value: '1k', label: '默认值' },
          { value: '2k', label: '2K' },
        ],
        aspectRatios: ['1:1'],
      }),
    );
    expect(configured.parameters).toEqual({ size: '1024x1024' });
  });
});

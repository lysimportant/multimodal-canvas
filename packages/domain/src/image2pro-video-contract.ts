import type { PortRole, VideoMode } from './index.js';

/** Image2Pro 精确型号合同；接口地址与按秒计费仍由 Image2Pro 网关承接。 */
export type Image2proVideoModelContract = {
  /** 模型目录中的精确 ID；大小写或后缀不同的名称不自动适配。 */
  modelAlias: string;
  family: 'image2pro';
  modes: readonly VideoMode[];
  confirmedInputRoles: readonly PortRole[];
  referenceLimits: { images: number; videos: number; audios: number; total: number };
  /** 参考音视频的单段时长范围及各媒体类别累计上限，单位秒；不混合累计视频和音频。 */
  referenceDurationSeconds: { min: number; max: number; total: number };
  /** 固定整数秒数；default 仅用于编辑器新建参数，不补写已冻结请求。 */
  duration: { min: number; max: number; default: number };
  /** 网关已确认的输出清晰度；默认 720p，不按目录旧质量字段推断。 */
  resolutions: readonly string[];
  defaultResolution: string;
  /** 已确认比例；adaptive 按模型及输入模式校验。 */
  aspectRatios: readonly string[];
  maxPromptLength: number;
  /** 新生成允许的节点参数；不同模型的布尔开关不互相继承。 */
  parameterKeys: readonly string[];
  /** 已确认的媒体格式；缺少 MIME 时不根据 URL 后缀推断。 */
  mediaMimeTypes: Readonly<Record<'image' | 'video' | 'audio', readonly string[]>>;
  /** 已冻结或内联文件的字节上限；省略时沿用原模型的传输限制。 */
  mediaMaxBytes?: Readonly<Record<'image' | 'video' | 'audio', number>>;
  /** H3 的所有模式均要求非空文本；Seedance 允许纯视觉参考。 */
  requiresPrompt: boolean;
  /** H3 允许文字配合纯音频参考；Seedance 仍要求视觉参考。 */
  allowsAudioOnlyReference: boolean;
  /** H3 帧模式只使用输入图比例，拒绝会被上游忽略的固定比例。 */
  requiresAdaptiveFrameRatio: boolean;
  /** H3 支持 MP4 内联视频；Seedance 视频继续使用可访问 URL。 */
  supportsVideoDataUrl: boolean;
};

/** 已确认的精确模型 ID，不包含渠道别名或通过前缀推断的名称。 */
export const image2proVideoModelAliases = Object.freeze([
  'Seedance2.0 0.9r',
  '无限制-Flash-MAX-Video',
]);

/** 已停止新生成的精确型号；历史画布和已受理任务保留原身份。 */
export const retiredImage2proVideoModelAliases = Object.freeze(['无限制-Flash-中配-Video']);

/** 新生成入口共用的退役提示，不回显用户参数。 */
export const retiredImage2proVideoModelReason =
  'Image2Pro Flash 中配视频模型已停止适配，请选择 Seedance2.0 0.9r 或无限制-Flash-MAX-Video';

/**
 * 判断精确型号是否已停止新生成，不影响已有公共任务查询。
 * @param modelAlias 节点或冻结任务的模型 ID，允许外围空白。
 * @returns 已退役 Flash 中配型号返回 true；其它名称返回 false。
 */
export function isRetiredImage2proVideoModel(modelAlias?: string): boolean {
  return retiredImage2proVideoModelAliases.includes(modelAlias?.trim() ?? '');
}

/** 两个型号共有的参数别名，引用仍只能来自受授权的画布端口或冻结提及。 */
const commonParameterKeys = Object.freeze([
  'prompt',
  'duration',
  'seconds',
  'durationSeconds',
  'aspectRatio',
  'aspect_ratio',
  'ratio',
  'resolution',
  'video_resolution',
  'videoResolution',
]);

/** Seedance 节点参数兼容白名单；具体模型必须读取 contract.parameterKeys。 */
export const image2proVideoParameterKeys = Object.freeze([
  ...commonParameterKeys,
  'generate_audio',
  'watermark',
  'return_last_frame',
]);

/** 只开放已明确适配的生成模式；编辑、延长和自动时长不推断额外语义或费用。 */
const image2proVideoContracts: ReadonlyMap<string, Image2proVideoModelContract> = new Map(
  image2proVideoModelAliases.map((modelAlias) => [
    modelAlias,
    Object.freeze({
      modelAlias,
      family: 'image2pro' as const,
      modes: Object.freeze([
        'text_to_video',
        'first_frame',
        'first_last_frame',
        'omni_reference',
      ] satisfies VideoMode[]),
      confirmedInputRoles: Object.freeze([
        'prompt',
        'firstFrame',
        'lastFrame',
        'referenceImage',
        'character',
        'style',
        'content',
        'audioTrack',
      ] satisfies PortRole[]),
      referenceLimits: Object.freeze({ images: 9, videos: 3, audios: 3, total: 15 }),
      referenceDurationSeconds: Object.freeze({ min: 2, max: 15, total: 15 }),
      duration: Object.freeze({
        min: 4,
        max: modelAlias === 'Seedance2.0 0.9r' ? 15 : 12,
        default: 5,
      }),
      resolutions: Object.freeze(
        modelAlias === 'Seedance2.0 0.9r' ? ['480p', '720p', '1080p', '4k'] : ['720p'],
      ),
      defaultResolution: '720p',
      aspectRatios: Object.freeze(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive']),
      maxPromptLength: modelAlias === 'Seedance2.0 0.9r' ? 30_000 : 7_000,
      parameterKeys:
        modelAlias === 'Seedance2.0 0.9r' ? image2proVideoParameterKeys : commonParameterKeys,
      mediaMimeTypes: Object.freeze({
        image: Object.freeze([
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/heic',
          'image/heif',
          ...(modelAlias === 'Seedance2.0 0.9r' ? ['image/bmp', 'image/tiff', 'image/gif'] : []),
        ]),
        video: Object.freeze(['video/mp4', 'video/quicktime']),
        audio: Object.freeze(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav']),
      }),
      requiresPrompt: modelAlias !== 'Seedance2.0 0.9r',
      allowsAudioOnlyReference: modelAlias !== 'Seedance2.0 0.9r',
      requiresAdaptiveFrameRatio: modelAlias !== 'Seedance2.0 0.9r',
      supportsVideoDataUrl: modelAlias !== 'Seedance2.0 0.9r',
      ...(modelAlias !== 'Seedance2.0 0.9r'
        ? {
            mediaMaxBytes: Object.freeze({
              image: 30 * 1024 * 1024,
              video: 50 * 1024 * 1024,
              audio: 15 * 1024 * 1024,
            }),
          }
        : {}),
    }),
  ]),
);

/**
 * 按精确 ID 读取 Image2Pro 合同，不影响旧画布数据或其它 Seedance 合同。
 * @param modelAlias 节点或冻结运行中的精确模型 ID，允许外围空白。
 * @returns 已确认合同；未知名称返回 undefined。
 */
export function image2proVideoContractForModel(
  modelAlias?: string,
): Image2proVideoModelContract | undefined {
  return modelAlias ? image2proVideoContracts.get(modelAlias.trim()) : undefined;
}

/** Image2Pro 参数错误；字段名可展示，消息不回显用户参数值。 */
export class Image2proVideoParameterError extends Error {
  /**
   * @param parameter 有问题的参数或别名组。
   * @param constraint 本地约束说明，不拼接用户原值。
   * @param code 不支持的字段与不合法值使用不同的非重试错误码。
   */
  constructor(
    readonly parameter: string,
    constraint: string,
    readonly code:
      | 'UNSUPPORTED_PROVIDER_PARAMETER'
      | 'INVALID_PROVIDER_PARAMETER' = 'INVALID_PROVIDER_PARAMETER',
  ) {
    super(`Image2Pro 视频参数 ${parameter} ${constraint}`);
    this.name = 'Image2proVideoParameterError';
  }
}

/** 解析后的官方参数；旧小数时长明确拒绝，比例缺省由 Provider 根据视觉参考选择。 */
export type Image2proVideoParameters = {
  seconds: number;
  resolution: string;
  aspectRatio?: string;
  generate_audio?: boolean;
  watermark?: boolean;
  return_last_frame?: boolean;
};

/**
 * 校验 Image2Pro 参数并归一画布历史别名，不修改原参数或丢弃不支持字段。
 * @param parameters 节点或冻结 Run 的参数；duration/seconds/durationSeconds 至少提供一个。
 * @param modelAlias 精确型号；省略时保持原 Seedance 参数调用兼容，不推断未知名称。
 * @returns 整数秒数、清晰度、可选比例及保留显式 false 的布尔开关，供 Web 预检、API 与 Provider 共用。
 * @throws Image2proVideoParameterError 未知字段、别名冲突、缺少时长或类型/范围非法。
 */
export function resolveImage2proVideoParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias = 'Seedance2.0 0.9r',
): Image2proVideoParameters {
  const contract = image2proVideoContractForModel(modelAlias);
  if (!contract) {
    throw new Image2proVideoParameterError(
      'model',
      '尚不支持此精确型号',
      'UNSUPPORTED_PROVIDER_PARAMETER',
    );
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && !contract.parameterKeys.includes(key)) {
      throw new Image2proVideoParameterError(
        key,
        '尚不支持，请明确移除后重试',
        'UNSUPPORTED_PROVIDER_PARAMETER',
      );
    }
  }
  if (
    parameters.prompt !== undefined &&
    (typeof parameters.prompt !== 'string' || parameters.prompt.length > contract.maxPromptLength)
  ) {
    throw new Image2proVideoParameterError(
      'prompt',
      `必须为不超过 ${contract.maxPromptLength} 字符的字符串`,
    );
  }
  if (
    contract.modelAlias === 'Seedance2.0 0.9r' &&
    typeof parameters.prompt === 'string' &&
    /(?:^|\s)--(?:duration|dur|frames|resolution|rs|ratio|rt|seed|camera_fixed|cf|watermark|wm)\b/i.test(
      parameters.prompt,
    )
  ) {
    throw new Image2proVideoParameterError(
      'prompt',
      '不能包含覆盖生成参数的 -- 标记，请使用明确参数字段',
    );
  }
  const durations = ['duration', 'seconds', 'durationSeconds'].flatMap((key) => {
    const value = parameters[key];
    if (value === undefined) return [];
    if (
      (typeof value !== 'number' && typeof value !== 'string') ||
      (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < contract.duration.min ||
      Number(value) > contract.duration.max
    ) {
      throw new Image2proVideoParameterError(
        key,
        `必须为 ${contract.duration.min} 至 ${contract.duration.max} 秒的整数；暂不支持自动时长`,
      );
    }
    return [Number(value)];
  });
  if (!durations.length) {
    throw new Image2proVideoParameterError('duration', '必须显式指定秒数');
  }
  if (new Set(durations).size > 1) {
    throw new Image2proVideoParameterError('duration/seconds/durationSeconds', '别名值冲突');
  }
  const ratios = ['aspectRatio', 'aspect_ratio', 'ratio'].flatMap((key) => {
    const value = parameters[key];
    if (value === undefined) return [];
    if (typeof value !== 'string' || !contract.aspectRatios.includes(value)) {
      throw new Image2proVideoParameterError(
        key,
        '仅支持 21:9、16:9、4:3、1:1、3:4、9:16 或 adaptive',
      );
    }
    return [value];
  });
  if (new Set(ratios).size > 1) {
    throw new Image2proVideoParameterError('aspectRatio/aspect_ratio/ratio', '别名值冲突');
  }
  const resolutions = ['resolution', 'video_resolution', 'videoResolution'].flatMap((key) => {
    const value = parameters[key];
    if (value === undefined) return [];
    if (typeof value !== 'string' || !contract.resolutions.includes(value.toLowerCase())) {
      throw new Image2proVideoParameterError(key, `仅支持 ${contract.resolutions.join('、')}`);
    }
    return [value.toLowerCase()];
  });
  if (new Set(resolutions).size > 1) {
    throw new Image2proVideoParameterError(
      'resolution/video_resolution/videoResolution',
      '别名值冲突',
    );
  }
  const flags: Pick<
    Image2proVideoParameters,
    'generate_audio' | 'watermark' | 'return_last_frame'
  > = {};
  for (const key of ['generate_audio', 'watermark', 'return_last_frame'] as const) {
    const value = parameters[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Image2proVideoParameterError(key, '必须为布尔值');
    flags[key] = value;
  }
  return {
    seconds: durations[0]!,
    resolution: resolutions[0] ?? contract.defaultResolution,
    ...(ratios.length ? { aspectRatio: ratios[0] } : {}),
    ...flags,
  };
}

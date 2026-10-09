import type { PortRole, VideoMode } from './index.js';

/** 源流已适配精确型号的参数与普通参考合同；不从目录新名称推断能力。 */
export type YuanliuVideoModelContract = {
  /** 插件声明的展示别名；通过上游 ID 查询时仍保留此别名。 */
  modelAlias: string;
  upstreamModel: string;
  family: 'yuanliu';
  modes: readonly VideoMode[];
  confirmedInputRoles: readonly PortRole[];
  /** 每类上限来自插件 MODEL_SPECS，总数同时受画布 40 项产品上限约束。 */
  referenceLimits: { images: number; videos: number; audios: number; total: number };
  /** 整秒范围；values 存在时仅允许离散档位，default 只供新建参数使用。 */
  duration: { min: number; max: number; default: number; values?: readonly number[] };
  resolutions: readonly string[];
  defaultResolution: string;
  aspectRatios: readonly string[];
  /** 与插件一致按 Unicode 字符计数，而非 UTF-16 代码单元。 */
  maxPromptLength: number;
  /** 节点参数白名单；媒体必须由受授权的端口或冻结提及提供。 */
  parameterKeys: readonly string[];
  requiresPrompt: true;
};

/** 与源流插件保守 MODEL_SPECS 对齐的型号差异，不含费用或推断出的媒体限制。 */
type YuanliuVideoModelSpec = {
  alias: string;
  min: number;
  max: number;
  durations?: readonly number[];
  resolutions?: readonly string[];
  adaptiveRatio?: 'auto' | 'adaptive';
  images: number;
  videos: number;
  audios: number;
  total?: number;
  prompt: number;
};

/** 已确认固定画幅；auto 和 adaptive 按各精确型号分别声明。 */
const fixedAspectRatios = Object.freeze(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9']);

/** 仅这 13 个上游 ID 及其插件别名可以采用源流协议。 */
const yuanliuVideoModelSpecs: Readonly<Record<string, YuanliuVideoModelSpec>> = {
  'seedance-2.5-guanfang-anmiao': {
    alias: 'Yuan-Seedance-2.5-Official',
    min: 4,
    max: 30,
    resolutions: ['480p', '720p', '1080p'],
    adaptiveRatio: 'adaptive',
    images: 30,
    videos: 0,
    audios: 10,
    prompt: 16_000,
  },
  yl_g7zy_seedance_v2_0_std: {
    alias: 'Yuan-Seedance-2.0-LJ',
    min: 4,
    max: 15,
    adaptiveRatio: 'auto',
    images: 9,
    videos: 0,
    audios: 0,
    prompt: 16_000,
  },
  yl_g7zy_seedance_v2_0_std_full: {
    alias: 'Yuan-Seedance-2.0-LJ-Full',
    min: 5,
    max: 15,
    adaptiveRatio: 'auto',
    images: 9,
    videos: 3,
    audios: 3,
    total: 15,
    prompt: 16_000,
  },
  yl_g7zy_seedance_v2_5: {
    alias: 'Yuan-Seedance-2.5-LJ',
    min: 4,
    max: 30,
    adaptiveRatio: 'auto',
    images: 30,
    videos: 0,
    audios: 0,
    prompt: 16_000,
  },
  yl_g7zy_seedance_v2_5_full: {
    alias: 'Yuan-Seedance-2.5-LJ-Full',
    min: 5,
    max: 30,
    adaptiveRatio: 'auto',
    images: 30,
    videos: 10,
    audios: 10,
    total: 50,
    prompt: 16_000,
  },
  'yl_seedance-2-0_ba0687ff09f2': {
    alias: 'Yuan-Seedance-2.0-HD',
    min: 5,
    max: 15,
    durations: [5, 10, 15],
    adaptiveRatio: 'adaptive',
    images: 9,
    videos: 0,
    audios: 0,
    prompt: 10_000,
  },
  'yl_seedance-2-5_6caffaca7390': {
    alias: 'Yuan-Seedance-2.5-HD',
    min: 4,
    max: 30,
    adaptiveRatio: 'adaptive',
    images: 30,
    videos: 0,
    audios: 0,
    prompt: 16_000,
  },
  'yl_seedance-2-5_0fab2f1b1f10': {
    alias: 'Yuan-Seedance-2.5-HD-Full',
    min: 10,
    max: 30,
    adaptiveRatio: 'adaptive',
    images: 30,
    videos: 10,
    audios: 10,
    prompt: 16_000,
  },
  'yl_seedance-2-5_750271498003': {
    alias: 'Yuan-Seedance-2.5-HD-PerSecond',
    min: 10,
    max: 30,
    adaptiveRatio: 'adaptive',
    images: 30,
    videos: 10,
    audios: 10,
    prompt: 16_000,
  },
  yl_api_hmstudio_seedance_v2_5_101010_7d58bbb217e6: {
    alias: 'Yuan-Seedance-2.5-YS-Full',
    min: 4,
    max: 30,
    images: 10,
    videos: 10,
    audios: 10,
    prompt: 16_000,
  },
  yl_api_hmstudio_seedance_v2_5_dc729300ff39: {
    alias: 'Yuan-Seedance-2.5-YS',
    min: 4,
    max: 30,
    images: 10,
    videos: 0,
    audios: 0,
    prompt: 16_000,
  },
  'yl_video-30_76dbb7993f8e': {
    alias: 'Yuan-Seedance-2.5-YL1',
    min: 30,
    max: 30,
    durations: [30],
    images: 9,
    videos: 0,
    audios: 0,
    prompt: 8_000,
  },
  yl_api_hmstudio_seedance_v2_0_514a65db713b: {
    alias: 'Yuan-Seedance-2.0-YS',
    min: 4,
    max: 15,
    images: 9,
    videos: 0,
    audios: 0,
    prompt: 16_000,
  },
};

/** 已适配的 13 个展示别名；上游目录发现不能扩大此列表。 */
export const yuanliuVideoModelAliases = Object.freeze(
  Object.values(yuanliuVideoModelSpecs).map((spec) => spec.alias),
);

/** 兼容画布历史参数别名，不接受绕过冻结资源或上游未支持的开关。 */
const yuanliuVideoParameterKeys = Object.freeze([
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
  'size',
]);

/** 展示别名和原始上游 ID 指向同一份不可变精确合同。 */
const yuanliuVideoContracts = new Map<string, YuanliuVideoModelContract>();
for (const [upstreamModel, spec] of Object.entries(yuanliuVideoModelSpecs)) {
  const confirmedInputRoles: PortRole[] = ['prompt', 'referenceImage', 'character', 'style'];
  if (spec.videos) confirmedInputRoles.push('content');
  if (spec.audios) confirmedInputRoles.push('audioTrack');
  const contract: YuanliuVideoModelContract = Object.freeze({
    modelAlias: spec.alias,
    upstreamModel,
    family: 'yuanliu',
    modes: Object.freeze(['text_to_video', 'omni_reference'] satisfies VideoMode[]),
    confirmedInputRoles: Object.freeze(confirmedInputRoles),
    referenceLimits: Object.freeze({
      images: spec.images,
      videos: spec.videos,
      audios: spec.audios,
      total: Math.min(spec.total ?? spec.images + spec.videos + spec.audios, 40),
    }),
    duration: Object.freeze({
      min: spec.min,
      max: spec.max,
      default: Math.max(spec.min, 5),
      ...(spec.durations ? { values: Object.freeze([...spec.durations]) } : {}),
    }),
    resolutions: Object.freeze([...(spec.resolutions ?? ['720p'])]),
    defaultResolution: '720p',
    aspectRatios: Object.freeze([
      ...(spec.adaptiveRatio ? [spec.adaptiveRatio] : []),
      ...fixedAspectRatios,
    ]),
    maxPromptLength: spec.prompt,
    parameterKeys: yuanliuVideoParameterKeys,
    requiresPrompt: true,
  });
  yuanliuVideoContracts.set(spec.alias, contract);
  yuanliuVideoContracts.set(upstreamModel, contract);
}

/**
 * 读取源流精确型号合同，不修改旧画布或借用普通 Seedance 的首尾帧语义。
 * @param modelAlias 冻结任务的模型别名或原始上游 ID，允许外围空白。
 * @returns 已适配合同；未知大小写、后缀和未适配型号返回 undefined。
 */
export function yuanliuVideoContractForModel(
  modelAlias?: string,
): YuanliuVideoModelContract | undefined {
  return modelAlias ? yuanliuVideoContracts.get(modelAlias.trim()) : undefined;
}

/** 未适配源流型号的拒绝说明，避免新目录名称借用通用文生或首帧协议。 */
export const unadaptedYuanliuVideoModelReason = '该源流视频型号尚未适配，请选择已确认的精确型号';

/**
 * 判断源流命名空间中是否存在没有精确合同的型号，只用于拒绝，不授予能力。
 * @param modelAlias 插件别名或上游 ID；大小写错误和新增后缀也需要明确修正。
 * @returns 已识别为源流但未适配时为 true，既有精确合同和其它厂商为 false。
 */
export function isUnadaptedYuanliuVideoModel(modelAlias?: string): boolean {
  const id = modelAlias?.trim() ?? '';
  return (
    /^(?:Yuan-|yl_|seedance-2\.5-guanfang-anmiao)/i.test(id) && !yuanliuVideoContractForModel(id)
  );
}

/** 源流参数错误；保留给旧调用方，不用于 Canvas 能力门禁。 */
export class YuanliuVideoParameterError extends Error {
  /**
   * @param parameter 有问题的参数或同义字段组。
   * @param constraint 已确认的本地约束。
   * @param code 未适配字段与非法值使用不同的不可重试错误码。
   */
  constructor(
    readonly parameter: string,
    constraint: string,
    readonly code:
      | 'UNSUPPORTED_PROVIDER_PARAMETER'
      | 'INVALID_PROVIDER_PARAMETER' = 'INVALID_PROVIDER_PARAMETER',
  ) {
    super(`源流视频参数 ${parameter} ${constraint}`);
    this.name = 'YuanliuVideoParameterError';
  }
}

/** 解析后的源流参数；duration 必须显式提供，不补写或更改冻结参数。 */
export type YuanliuVideoParameters = {
  seconds?: unknown;
  resolution?: unknown;
  aspectRatio?: unknown;
};

/**
 * 归一画布同义字段，媒体仍来自受授权冻结输入；能力与取值交给上游判断。
 * @param parameters 节点或冻结 Run 的参数；必须显式指定 duration/seconds/durationSeconds。
 * @param modelAlias 已适配展示别名或上游 ID。
 * @returns 已提供的时长、清晰度与比例；缺失值保持缺失，不臆造供应商默认值。
 */
export function resolveYuanliuVideoParameters(
  parameters: Readonly<Record<string, unknown>>,
  modelAlias: string,
): YuanliuVideoParameters {
  const read = (keys: string[], fallback?: unknown): unknown => {
    for (const key of keys) {
      if (parameters[key] !== undefined) return parameters[key];
    }
    return fallback;
  };
  const rawSeconds = read(['duration', 'seconds', 'durationSeconds']);
  const resolution = read(['resolution', 'video_resolution', 'videoResolution']);
  const aspectRatio = read(['aspectRatio', 'aspect_ratio', 'ratio']);
  const normalizedSeconds =
    typeof rawSeconds === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(rawSeconds.trim())
      ? Number(rawSeconds)
      : rawSeconds;
  return {
    ...(normalizedSeconds !== undefined ? { seconds: normalizedSeconds } : {}),
    ...(resolution !== undefined ? { resolution } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
  };
}

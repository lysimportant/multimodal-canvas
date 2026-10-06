import type { PortRole, VideoMode } from './index.js';

/** Moon 视频模型的独立合同族；这些值不等同于其它 Provider 的 Seed/Grok 家族。 */
export type MoonVideoModelFamily =
  | 'moon-seedance-2'
  | 'moon-seedance-2.5-official'
  | 'moon-pt'
  | 'moon-budget'
  | 'moon-grok-v1.5-video';

/** 一个输出分辨率下允许的整数秒数范围。 */
export type MoonVideoResolutionRange = {
  min: number;
  max: number;
};

/** Moon 视频参考素材的数量边界。 */
export type MoonVideoReferenceLimits = {
  images: number;
  videos: number;
  audios: number;
  total: number;
};

/** 输出时长的默认值与合同边界。 */
export type MoonVideoDuration = {
  min: number;
  max: number;
  default: number;
};

/**
 * New API Moon 视频单模型合同。
 *
 * `modelAlias` 必须是目录返回的精确 ID；调用方不得按前缀或相似名称推断
 * 能力；它不改变持久化的 `VideoMode` 枚举。
 */
export type MoonVideoModelContract = {
  modelAlias: string;
  family: MoonVideoModelFamily;
  resolutions: Record<string, MoonVideoResolutionRange>;
  defaultResolution: string;
  aspectRatios: readonly string[];
  modes: readonly VideoMode[];
  referenceLimits: MoonVideoReferenceLimits;
  supportsAutomaticDuration: boolean;
  duration: MoonVideoDuration;
  maxPromptLength: number;
  supportsAudioOnlyReferences: boolean;
  /** 首尾帧不能与其它参考素材混用的合同。 */
  frameReferencesExclusive?: boolean;
  supportsVideoEdit: boolean;
  supportsVideoExtend: boolean;
  /** 每个参考视频允许的冻结时长；未声明表示该模型没有此项限制。 */
  referenceVideoDurationSeconds?: {
    min: number;
    max: number;
  };
  /** 单个参考音频允许的冻结时长；PT 合同要求 2..30 秒。 */
  referenceAudioDurationSeconds?: {
    min: number;
    max: number;
  };
  /** 已确认可发送到网关的媒体输入角色。 */
  confirmedInputRoles: readonly PortRole[];
};

const allReferenceModes: readonly VideoMode[] = [
  'text_to_video',
  'first_frame',
  'first_last_frame',
  'omni_reference',
];
const allSeedanceModes: readonly VideoMode[] = [...allReferenceModes, 'video_edit', 'video_extend'];
const moonReferenceRoles: readonly PortRole[] = [
  'prompt',
  'firstFrame',
  'lastFrame',
  'character',
  'style',
  'referenceImage',
  'content',
  'audioTrack',
];
const moonGrokRoles: readonly PortRole[] = [
  'prompt',
  'firstFrame',
  'character',
  'style',
  'referenceImage',
];

/** 冻结单模型合同及其嵌套集合，避免运行期被调用方意外修改。 */
function contract(input: MoonVideoModelContract): MoonVideoModelContract {
  return Object.freeze({
    ...input,
    frameReferencesExclusive: input.frameReferencesExclusive ?? false,
    resolutions: Object.freeze({ ...input.resolutions }),
    aspectRatios: Object.freeze([...input.aspectRatios]),
    modes: Object.freeze([...input.modes]),
    referenceLimits: Object.freeze({ ...input.referenceLimits }),
    duration: Object.freeze({ ...input.duration }),
    confirmedInputRoles: Object.freeze([...input.confirmedInputRoles]),
    ...(input.referenceVideoDurationSeconds
      ? { referenceVideoDurationSeconds: Object.freeze({ ...input.referenceVideoDurationSeconds }) }
      : {}),
    ...(input.referenceAudioDurationSeconds
      ? { referenceAudioDurationSeconds: Object.freeze({ ...input.referenceAudioDurationSeconds }) }
      : {}),
  });
}

/** 已核验的精确 Moon 视频模型合同表；键名必须与模型目录 ID 完全一致。 */
const MOON_VIDEO_CONTRACTS: Record<string, MoonVideoModelContract> = {
  'artsdance-2-0-pro-260801': contract({
    modelAlias: 'artsdance-2-0-pro-260801',
    family: 'moon-seedance-2',
    resolutions: {
      '480p': { min: 4, max: 15 },
      '720p': { min: 4, max: 15 },
      '1080p': { min: 4, max: 15 },
      '4k': { min: 4, max: 15 },
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allSeedanceModes,
    referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
    supportsAutomaticDuration: true,
    duration: { min: 4, max: 15, default: 5 },
    maxPromptLength: 20_000,
    supportsAudioOnlyReferences: false,
    supportsVideoEdit: true,
    supportsVideoExtend: true,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'seedance-2-5-official': contract({
    modelAlias: 'seedance-2-5-official',
    family: 'moon-seedance-2.5-official',
    resolutions: { '720p': { min: 4, max: 30 }, '1080p': { min: 4, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allSeedanceModes,
    referenceLimits: { images: 30, videos: 10, audios: 10, total: 50 },
    supportsAutomaticDuration: true,
    duration: { min: 4, max: 30, default: 5 },
    maxPromptLength: 20_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: true,
    supportsVideoExtend: true,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'seedance2.0-9-3-3-PT': contract({
    modelAlias: 'seedance2.0-9-3-3-PT',
    family: 'moon-pt',
    resolutions: { '480p': { min: 5, max: 15 }, '720p': { min: 5, max: 15 } },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 15, default: 5 },
    maxPromptLength: 6_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: { min: 2, max: 30 },
    referenceAudioDurationSeconds: { min: 2, max: 30 },
  }),
  'seedance2.5-30-10-10-PT': contract({
    modelAlias: 'seedance2.5-30-10-10-PT',
    family: 'moon-pt',
    resolutions: { '480p': { min: 5, max: 30 }, '720p': { min: 5, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: { images: 30, videos: 10, audios: 10, total: 50 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 30, default: 5 },
    maxPromptLength: 10_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: { min: 2, max: 30 },
    referenceAudioDurationSeconds: { min: 2, max: 30 },
  }),
  'seedance2.0-fast-PT': contract({
    modelAlias: 'seedance2.0-fast-PT',
    family: 'moon-pt',
    resolutions: { '480p': { min: 5, max: 15 }, '720p': { min: 5, max: 15 } },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 0, audios: 3, total: 12 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 15, default: 5 },
    maxPromptLength: 4_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: { min: 2, max: 30 },
    referenceAudioDurationSeconds: { min: 2, max: 30 },
  }),
  sd2mini: contract({
    modelAlias: 'sd2mini',
    family: 'moon-budget',
    resolutions: { '480p': { min: 5, max: 15 }, '720p': { min: 5, max: 12 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 15, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2-930-face': contract({
    modelAlias: 'sd2-930-face',
    family: 'moon-budget',
    resolutions: { '720p': { min: 4, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 0, audios: 3, total: 12 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 30, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2.5-30-10-face': contract({
    modelAlias: 'sd2.5-30-10-face',
    family: 'moon-budget',
    resolutions: { '720p': { min: 4, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 30, videos: 0, audios: 10, total: 40 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 30, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2-930-fast': contract({
    modelAlias: 'sd2-930-fast',
    family: 'moon-budget',
    resolutions: { '720p': { min: 5, max: 15 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 15, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2-930-no-face': contract({
    modelAlias: 'sd2-930-no-face',
    family: 'moon-budget',
    resolutions: { '720p': { min: 4, max: 15 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 9, videos: 3, audios: 3, total: 15 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 15, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2.5-30-10-10-480': contract({
    modelAlias: 'sd2.5-30-10-10-480',
    family: 'moon-budget',
    resolutions: { '480p': { min: 4, max: 30 } },
    defaultResolution: '480p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 30, videos: 10, audios: 10, total: 50 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 30, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2.5-30-10-10': contract({
    modelAlias: 'sd2.5-30-10-10',
    family: 'moon-budget',
    resolutions: { '720p': { min: 4, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 30, videos: 10, audios: 10, total: 50 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 30, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'sd2.5-30-10-10-per-request': contract({
    modelAlias: 'sd2.5-30-10-10-per-request',
    family: 'moon-budget',
    resolutions: { '720p': { min: 5, max: 30 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: { images: 30, videos: 3, audios: 3, total: 36 },
    supportsAutomaticDuration: false,
    duration: { min: 5, max: 30, default: 5 },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
  }),
  'grok-v1.5-video': contract({
    modelAlias: 'grok-v1.5-video',
    family: 'moon-grok-v1.5-video',
    resolutions: { '720p': { min: 4, max: 15 }, '1080p': { min: 4, max: 15 } },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['text_to_video', 'first_frame', 'omni_reference'],
    referenceLimits: { images: 7, videos: 0, audios: 0, total: 7 },
    supportsAutomaticDuration: false,
    duration: { min: 4, max: 15, default: 6 },
    maxPromptLength: 32_000,
    supportsAudioOnlyReferences: false,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonGrokRoles,
  }),
};

/**
 * 返回精确 Moon 模型合同；未知、大小写不同或仅相似的别名均返回 undefined。
 * @param modelAlias New API 模型目录中的精确模型 ID。
 * @returns 共享模型合同，或未确认时的 undefined。
 */
export function moonVideoContractForModel(modelAlias?: string): MoonVideoModelContract | undefined {
  const exact = modelAlias?.trim();
  return exact && Object.hasOwn(MOON_VIDEO_CONTRACTS, exact)
    ? MOON_VIDEO_CONTRACTS[exact]
    : undefined;
}

/** 只读暴露已确认的精确模型 ID，供目录回归和宿主预检使用。 */
export const moonVideoModelAliases = Object.freeze(Object.keys(MOON_VIDEO_CONTRACTS).sort());

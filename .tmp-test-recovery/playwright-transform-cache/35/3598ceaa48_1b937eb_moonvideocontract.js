// 5013a49d219dfd9c96d1376a3fde0948e1f0edd8
const allReferenceModes = ['text_to_video', 'first_frame', 'first_last_frame', 'omni_reference'];
const allSeedanceModes = [...allReferenceModes, 'video_edit', 'video_extend'];
const moonReferenceRoles = ['prompt', 'firstFrame', 'lastFrame', 'character', 'style', 'referenceImage', 'content', 'audioTrack'];
const moonGrokRoles = ['prompt', 'firstFrame', 'character', 'style', 'referenceImage'];
/** 冻结单模型合同及其嵌套集合，避免运行期被调用方意外修改。 */
function contract(input) {
  return Object.freeze({
    ...input,
    frameReferencesExclusive: input.frameReferencesExclusive ?? false,
    resolutions: Object.freeze({
      ...input.resolutions
    }),
    aspectRatios: Object.freeze([...input.aspectRatios]),
    modes: Object.freeze([...input.modes]),
    referenceLimits: Object.freeze({
      ...input.referenceLimits
    }),
    duration: Object.freeze({
      ...input.duration
    }),
    confirmedInputRoles: Object.freeze([...input.confirmedInputRoles]),
    ...(input.referenceVideoDurationSeconds ? {
      referenceVideoDurationSeconds: Object.freeze({
        ...input.referenceVideoDurationSeconds
      })
    } : {}),
    ...(input.referenceAudioDurationSeconds ? {
      referenceAudioDurationSeconds: Object.freeze({
        ...input.referenceAudioDurationSeconds
      })
    } : {})
  });
}
/** 已核验的精确 Moon 视频模型合同表；键名必须与模型目录 ID 完全一致。 */
const MOON_VIDEO_CONTRACTS = {
  'artsdance-2-0-pro-260801': contract({
    modelAlias: 'artsdance-2-0-pro-260801',
    family: 'moon-seedance-2',
    resolutions: {
      '480p': {
        min: 4,
        max: 15
      },
      '720p': {
        min: 4,
        max: 15
      },
      '1080p': {
        min: 4,
        max: 15
      },
      '4k': {
        min: 4,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allSeedanceModes,
    referenceLimits: {
      images: 9,
      videos: 3,
      audios: 3,
      total: 15
    },
    supportsAutomaticDuration: true,
    duration: {
      min: 4,
      max: 15,
      default: 5
    },
    maxPromptLength: 20_000,
    supportsAudioOnlyReferences: false,
    supportsVideoEdit: true,
    supportsVideoExtend: true,
    confirmedInputRoles: moonReferenceRoles
  }),
  'seedance-2-5-official': contract({
    modelAlias: 'seedance-2-5-official',
    family: 'moon-seedance-2.5-official',
    resolutions: {
      '720p': {
        min: 4,
        max: 30
      },
      '1080p': {
        min: 4,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allSeedanceModes,
    referenceLimits: {
      images: 30,
      videos: 10,
      audios: 10,
      total: 50
    },
    supportsAutomaticDuration: true,
    duration: {
      min: 4,
      max: 30,
      default: 5
    },
    maxPromptLength: 20_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: true,
    supportsVideoExtend: true,
    confirmedInputRoles: moonReferenceRoles
  }),
  'seedance2.0-9-3-3-PT': contract({
    modelAlias: 'seedance2.0-9-3-3-PT',
    family: 'moon-pt',
    resolutions: {
      '480p': {
        min: 5,
        max: 15
      },
      '720p': {
        min: 5,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 3,
      audios: 3,
      total: 15
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 15,
      default: 5
    },
    maxPromptLength: 6_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: {
      min: 2,
      max: 30
    },
    referenceAudioDurationSeconds: {
      min: 2,
      max: 30
    }
  }),
  'seedance2.5-30-10-10-PT': contract({
    modelAlias: 'seedance2.5-30-10-10-PT',
    family: 'moon-pt',
    resolutions: {
      '480p': {
        min: 5,
        max: 30
      },
      '720p': {
        min: 5,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 30,
      videos: 10,
      audios: 10,
      total: 50
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 30,
      default: 5
    },
    maxPromptLength: 10_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: {
      min: 2,
      max: 30
    },
    referenceAudioDurationSeconds: {
      min: 2,
      max: 30
    }
  }),
  'seedance2.0-fast-PT': contract({
    modelAlias: 'seedance2.0-fast-PT',
    family: 'moon-pt',
    resolutions: {
      '480p': {
        min: 5,
        max: 15
      },
      '720p': {
        min: 5,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 0,
      audios: 3,
      total: 12
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 15,
      default: 5
    },
    maxPromptLength: 4_000,
    supportsAudioOnlyReferences: true,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles,
    referenceVideoDurationSeconds: {
      min: 2,
      max: 30
    },
    referenceAudioDurationSeconds: {
      min: 2,
      max: 30
    }
  }),
  sd2mini: contract({
    modelAlias: 'sd2mini',
    family: 'moon-budget',
    resolutions: {
      '480p': {
        min: 5,
        max: 15
      },
      '720p': {
        min: 5,
        max: 12
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 3,
      audios: 3,
      total: 15
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 15,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2-930-face': contract({
    modelAlias: 'sd2-930-face',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 4,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 0,
      audios: 3,
      total: 12
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 30,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2.5-30-10-face': contract({
    modelAlias: 'sd2.5-30-10-face',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 4,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 30,
      videos: 0,
      audios: 10,
      total: 40
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 30,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2-930-fast': contract({
    modelAlias: 'sd2-930-fast',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 5,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 3,
      audios: 3,
      total: 15
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 15,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2-930-no-face': contract({
    modelAlias: 'sd2-930-no-face',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 4,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 9,
      videos: 3,
      audios: 3,
      total: 15
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 15,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2.5-30-10-10-480': contract({
    modelAlias: 'sd2.5-30-10-10-480',
    family: 'moon-budget',
    resolutions: {
      '480p': {
        min: 4,
        max: 30
      }
    },
    defaultResolution: '480p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 30,
      videos: 10,
      audios: 10,
      total: 50
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 30,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2.5-30-10-10': contract({
    modelAlias: 'sd2.5-30-10-10',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 4,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 30,
      videos: 10,
      audios: 10,
      total: 50
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 30,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'sd2.5-30-10-10-per-request': contract({
    modelAlias: 'sd2.5-30-10-10-per-request',
    family: 'moon-budget',
    resolutions: {
      '720p': {
        min: 5,
        max: 30
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: allReferenceModes,
    referenceLimits: {
      images: 30,
      videos: 3,
      audios: 3,
      total: 36
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 5,
      max: 30,
      default: 5
    },
    maxPromptLength: 5_000,
    supportsAudioOnlyReferences: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonReferenceRoles
  }),
  'grok-v1.5-video': contract({
    modelAlias: 'grok-v1.5-video',
    family: 'moon-grok-v1.5-video',
    resolutions: {
      '720p': {
        min: 4,
        max: 15
      },
      '1080p': {
        min: 4,
        max: 15
      }
    },
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    modes: ['text_to_video', 'first_frame', 'omni_reference'],
    referenceLimits: {
      images: 7,
      videos: 0,
      audios: 0,
      total: 7
    },
    supportsAutomaticDuration: false,
    duration: {
      min: 4,
      max: 15,
      default: 6
    },
    maxPromptLength: 32_000,
    supportsAudioOnlyReferences: false,
    frameReferencesExclusive: true,
    supportsVideoEdit: false,
    supportsVideoExtend: false,
    confirmedInputRoles: moonGrokRoles
  })
};
/**
 * 返回精确 Moon 模型合同；未知、大小写不同或仅相似的别名均返回 undefined。
 * @param modelAlias New API 模型目录中的精确模型 ID。
 * @returns 共享模型合同，或未确认时的 undefined。
 */
export function moonVideoContractForModel(modelAlias) {
  const exact = modelAlias?.trim();
  return exact && Object.hasOwn(MOON_VIDEO_CONTRACTS, exact) ? MOON_VIDEO_CONTRACTS[exact] : undefined;
}
/** 只读暴露已确认的精确模型 ID，供目录回归和宿主预检使用。 */
export const moonVideoModelAliases = Object.freeze(Object.keys(MOON_VIDEO_CONTRACTS).sort());
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJhbGxSZWZlcmVuY2VNb2RlcyIsImFsbFNlZWRhbmNlTW9kZXMiLCJtb29uUmVmZXJlbmNlUm9sZXMiLCJtb29uR3Jva1JvbGVzIiwiY29udHJhY3QiLCJpbnB1dCIsIk9iamVjdCIsImZyZWV6ZSIsImZyYW1lUmVmZXJlbmNlc0V4Y2x1c2l2ZSIsInJlc29sdXRpb25zIiwiYXNwZWN0UmF0aW9zIiwibW9kZXMiLCJyZWZlcmVuY2VMaW1pdHMiLCJkdXJhdGlvbiIsImNvbmZpcm1lZElucHV0Um9sZXMiLCJyZWZlcmVuY2VWaWRlb0R1cmF0aW9uU2Vjb25kcyIsInJlZmVyZW5jZUF1ZGlvRHVyYXRpb25TZWNvbmRzIiwiTU9PTl9WSURFT19DT05UUkFDVFMiLCJtb2RlbEFsaWFzIiwiZmFtaWx5IiwibWluIiwibWF4IiwiZGVmYXVsdFJlc29sdXRpb24iLCJpbWFnZXMiLCJ2aWRlb3MiLCJhdWRpb3MiLCJ0b3RhbCIsInN1cHBvcnRzQXV0b21hdGljRHVyYXRpb24iLCJkZWZhdWx0IiwibWF4UHJvbXB0TGVuZ3RoIiwic3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzIiwic3VwcG9ydHNWaWRlb0VkaXQiLCJzdXBwb3J0c1ZpZGVvRXh0ZW5kIiwic2QybWluaSIsIm1vb25WaWRlb0NvbnRyYWN0Rm9yTW9kZWwiLCJleGFjdCIsInRyaW0iLCJoYXNPd24iLCJ1bmRlZmluZWQiLCJtb29uVmlkZW9Nb2RlbEFsaWFzZXMiLCJrZXlzIiwic29ydCJdLCJzb3VyY2VzIjpbIm1vb24tdmlkZW8tY29udHJhY3QuanMiXSwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgYWxsUmVmZXJlbmNlTW9kZXMgPSBbXG4gICAgJ3RleHRfdG9fdmlkZW8nLFxuICAgICdmaXJzdF9mcmFtZScsXG4gICAgJ2ZpcnN0X2xhc3RfZnJhbWUnLFxuICAgICdvbW5pX3JlZmVyZW5jZScsXG5dO1xuY29uc3QgYWxsU2VlZGFuY2VNb2RlcyA9IFsuLi5hbGxSZWZlcmVuY2VNb2RlcywgJ3ZpZGVvX2VkaXQnLCAndmlkZW9fZXh0ZW5kJ107XG5jb25zdCBtb29uUmVmZXJlbmNlUm9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ2ZpcnN0RnJhbWUnLFxuICAgICdsYXN0RnJhbWUnLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG4gICAgJ3JlZmVyZW5jZUltYWdlJyxcbiAgICAnY29udGVudCcsXG4gICAgJ2F1ZGlvVHJhY2snLFxuXTtcbmNvbnN0IG1vb25Hcm9rUm9sZXMgPSBbXG4gICAgJ3Byb21wdCcsXG4gICAgJ2ZpcnN0RnJhbWUnLFxuICAgICdjaGFyYWN0ZXInLFxuICAgICdzdHlsZScsXG4gICAgJ3JlZmVyZW5jZUltYWdlJyxcbl07XG4vKiog5Ya757uT5Y2V5qih5Z6L5ZCI5ZCM5Y+K5YW25bWM5aWX6ZuG5ZCI77yM6YG/5YWN6L+Q6KGM5pyf6KKr6LCD55So5pa55oSP5aSW5L+u5pS544CCICovXG5mdW5jdGlvbiBjb250cmFjdChpbnB1dCkge1xuICAgIHJldHVybiBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgLi4uaW5wdXQsXG4gICAgICAgIGZyYW1lUmVmZXJlbmNlc0V4Y2x1c2l2ZTogaW5wdXQuZnJhbWVSZWZlcmVuY2VzRXhjbHVzaXZlID8/IGZhbHNlLFxuICAgICAgICByZXNvbHV0aW9uczogT2JqZWN0LmZyZWV6ZSh7IC4uLmlucHV0LnJlc29sdXRpb25zIH0pLFxuICAgICAgICBhc3BlY3RSYXRpb3M6IE9iamVjdC5mcmVlemUoWy4uLmlucHV0LmFzcGVjdFJhdGlvc10pLFxuICAgICAgICBtb2RlczogT2JqZWN0LmZyZWV6ZShbLi4uaW5wdXQubW9kZXNdKSxcbiAgICAgICAgcmVmZXJlbmNlTGltaXRzOiBPYmplY3QuZnJlZXplKHsgLi4uaW5wdXQucmVmZXJlbmNlTGltaXRzIH0pLFxuICAgICAgICBkdXJhdGlvbjogT2JqZWN0LmZyZWV6ZSh7IC4uLmlucHV0LmR1cmF0aW9uIH0pLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBPYmplY3QuZnJlZXplKFsuLi5pbnB1dC5jb25maXJtZWRJbnB1dFJvbGVzXSksXG4gICAgICAgIC4uLihpbnB1dC5yZWZlcmVuY2VWaWRlb0R1cmF0aW9uU2Vjb25kc1xuICAgICAgICAgICAgPyB7IHJlZmVyZW5jZVZpZGVvRHVyYXRpb25TZWNvbmRzOiBPYmplY3QuZnJlZXplKHsgLi4uaW5wdXQucmVmZXJlbmNlVmlkZW9EdXJhdGlvblNlY29uZHMgfSkgfVxuICAgICAgICAgICAgOiB7fSksXG4gICAgICAgIC4uLihpbnB1dC5yZWZlcmVuY2VBdWRpb0R1cmF0aW9uU2Vjb25kc1xuICAgICAgICAgICAgPyB7IHJlZmVyZW5jZUF1ZGlvRHVyYXRpb25TZWNvbmRzOiBPYmplY3QuZnJlZXplKHsgLi4uaW5wdXQucmVmZXJlbmNlQXVkaW9EdXJhdGlvblNlY29uZHMgfSkgfVxuICAgICAgICAgICAgOiB7fSksXG4gICAgfSk7XG59XG4vKiog5bey5qC46aqM55qE57K+56GuIE1vb24g6KeG6aKR5qih5Z6L5ZCI5ZCM6KGo77yb6ZSu5ZCN5b+F6aG75LiO5qih5Z6L55uu5b2VIElEIOWujOWFqOS4gOiHtOOAgiAqL1xuY29uc3QgTU9PTl9WSURFT19DT05UUkFDVFMgPSB7XG4gICAgJ2FydHNkYW5jZS0yLTAtcHJvLTI2MDgwMSc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ2FydHNkYW5jZS0yLTAtcHJvLTI2MDgwMScsXG4gICAgICAgIGZhbWlseTogJ21vb24tc2VlZGFuY2UtMicsXG4gICAgICAgIHJlc29sdXRpb25zOiB7XG4gICAgICAgICAgICAnNDgwcCc6IHsgbWluOiA0LCBtYXg6IDE1IH0sXG4gICAgICAgICAgICAnNzIwcCc6IHsgbWluOiA0LCBtYXg6IDE1IH0sXG4gICAgICAgICAgICAnMTA4MHAnOiB7IG1pbjogNCwgbWF4OiAxNSB9LFxuICAgICAgICAgICAgJzRrJzogeyBtaW46IDQsIG1heDogMTUgfSxcbiAgICAgICAgfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzIxOjknLCAnMTY6OScsICc0OjMnLCAnMToxJywgJzM6NCcsICc5OjE2JywgJ2FkYXB0aXZlJ10sXG4gICAgICAgIG1vZGVzOiBhbGxTZWVkYW5jZU1vZGVzLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiA5LCB2aWRlb3M6IDMsIGF1ZGlvczogMywgdG90YWw6IDE1IH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IHRydWUsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNCwgbWF4OiAxNSwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDIwXzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiBmYWxzZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0VkaXQ6IHRydWUsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IHRydWUsXG4gICAgICAgIGNvbmZpcm1lZElucHV0Um9sZXM6IG1vb25SZWZlcmVuY2VSb2xlcyxcbiAgICB9KSxcbiAgICAnc2VlZGFuY2UtMi01LW9mZmljaWFsJzogY29udHJhY3Qoe1xuICAgICAgICBtb2RlbEFsaWFzOiAnc2VlZGFuY2UtMi01LW9mZmljaWFsJyxcbiAgICAgICAgZmFtaWx5OiAnbW9vbi1zZWVkYW5jZS0yLjUtb2ZmaWNpYWwnLFxuICAgICAgICByZXNvbHV0aW9uczogeyAnNzIwcCc6IHsgbWluOiA0LCBtYXg6IDMwIH0sICcxMDgwcCc6IHsgbWluOiA0LCBtYXg6IDMwIH0gfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzIxOjknLCAnMTY6OScsICc0OjMnLCAnMToxJywgJzM6NCcsICc5OjE2JywgJ2FkYXB0aXZlJ10sXG4gICAgICAgIG1vZGVzOiBhbGxTZWVkYW5jZU1vZGVzLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiAzMCwgdmlkZW9zOiAxMCwgYXVkaW9zOiAxMCwgdG90YWw6IDUwIH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IHRydWUsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNCwgbWF4OiAzMCwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDIwXzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogdHJ1ZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0V4dGVuZDogdHJ1ZSxcbiAgICAgICAgY29uZmlybWVkSW5wdXRSb2xlczogbW9vblJlZmVyZW5jZVJvbGVzLFxuICAgIH0pLFxuICAgICdzZWVkYW5jZTIuMC05LTMtMy1QVCc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NlZWRhbmNlMi4wLTktMy0zLVBUJyxcbiAgICAgICAgZmFtaWx5OiAnbW9vbi1wdCcsXG4gICAgICAgIHJlc29sdXRpb25zOiB7ICc0ODBwJzogeyBtaW46IDUsIG1heDogMTUgfSwgJzcyMHAnOiB7IG1pbjogNSwgbWF4OiAxNSB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNzIwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycyMTo5JywgJzE2OjknLCAnNDozJywgJzE6MScsICczOjQnLCAnOToxNicsICdhZGFwdGl2ZSddLFxuICAgICAgICBtb2RlczogYWxsUmVmZXJlbmNlTW9kZXMsXG4gICAgICAgIHJlZmVyZW5jZUxpbWl0czogeyBpbWFnZXM6IDksIHZpZGVvczogMywgYXVkaW9zOiAzLCB0b3RhbDogMTUgfSxcbiAgICAgICAgc3VwcG9ydHNBdXRvbWF0aWNEdXJhdGlvbjogZmFsc2UsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNSwgbWF4OiAxNSwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDZfMDAwLFxuICAgICAgICBzdXBwb3J0c0F1ZGlvT25seVJlZmVyZW5jZXM6IHRydWUsXG4gICAgICAgIGZyYW1lUmVmZXJlbmNlc0V4Y2x1c2l2ZTogdHJ1ZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0VkaXQ6IGZhbHNlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRXh0ZW5kOiBmYWxzZSxcbiAgICAgICAgY29uZmlybWVkSW5wdXRSb2xlczogbW9vblJlZmVyZW5jZVJvbGVzLFxuICAgICAgICByZWZlcmVuY2VWaWRlb0R1cmF0aW9uU2Vjb25kczogeyBtaW46IDIsIG1heDogMzAgfSxcbiAgICAgICAgcmVmZXJlbmNlQXVkaW9EdXJhdGlvblNlY29uZHM6IHsgbWluOiAyLCBtYXg6IDMwIH0sXG4gICAgfSksXG4gICAgJ3NlZWRhbmNlMi41LTMwLTEwLTEwLVBUJzogY29udHJhY3Qoe1xuICAgICAgICBtb2RlbEFsaWFzOiAnc2VlZGFuY2UyLjUtMzAtMTAtMTAtUFQnLFxuICAgICAgICBmYW1pbHk6ICdtb29uLXB0JyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzQ4MHAnOiB7IG1pbjogNSwgbWF4OiAzMCB9LCAnNzIwcCc6IHsgbWluOiA1LCBtYXg6IDMwIH0gfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzIxOjknLCAnMTY6OScsICc0OjMnLCAnMToxJywgJzM6NCcsICc5OjE2JywgJ2FkYXB0aXZlJ10sXG4gICAgICAgIG1vZGVzOiBhbGxSZWZlcmVuY2VNb2RlcyxcbiAgICAgICAgcmVmZXJlbmNlTGltaXRzOiB7IGltYWdlczogMzAsIHZpZGVvczogMTAsIGF1ZGlvczogMTAsIHRvdGFsOiA1MCB9LFxuICAgICAgICBzdXBwb3J0c0F1dG9tYXRpY0R1cmF0aW9uOiBmYWxzZSxcbiAgICAgICAgZHVyYXRpb246IHsgbWluOiA1LCBtYXg6IDMwLCBkZWZhdWx0OiA1IH0sXG4gICAgICAgIG1heFByb21wdExlbmd0aDogMTBfMDAwLFxuICAgICAgICBzdXBwb3J0c0F1ZGlvT25seVJlZmVyZW5jZXM6IHRydWUsXG4gICAgICAgIGZyYW1lUmVmZXJlbmNlc0V4Y2x1c2l2ZTogdHJ1ZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0VkaXQ6IGZhbHNlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRXh0ZW5kOiBmYWxzZSxcbiAgICAgICAgY29uZmlybWVkSW5wdXRSb2xlczogbW9vblJlZmVyZW5jZVJvbGVzLFxuICAgICAgICByZWZlcmVuY2VWaWRlb0R1cmF0aW9uU2Vjb25kczogeyBtaW46IDIsIG1heDogMzAgfSxcbiAgICAgICAgcmVmZXJlbmNlQXVkaW9EdXJhdGlvblNlY29uZHM6IHsgbWluOiAyLCBtYXg6IDMwIH0sXG4gICAgfSksXG4gICAgJ3NlZWRhbmNlMi4wLWZhc3QtUFQnOiBjb250cmFjdCh7XG4gICAgICAgIG1vZGVsQWxpYXM6ICdzZWVkYW5jZTIuMC1mYXN0LVBUJyxcbiAgICAgICAgZmFtaWx5OiAnbW9vbi1wdCcsXG4gICAgICAgIHJlc29sdXRpb25zOiB7ICc0ODBwJzogeyBtaW46IDUsIG1heDogMTUgfSwgJzcyMHAnOiB7IG1pbjogNSwgbWF4OiAxNSB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNzIwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycyMTo5JywgJzE2OjknLCAnNDozJywgJzE6MScsICczOjQnLCAnOToxNicsICdhZGFwdGl2ZSddLFxuICAgICAgICBtb2RlczogYWxsUmVmZXJlbmNlTW9kZXMsXG4gICAgICAgIHJlZmVyZW5jZUxpbWl0czogeyBpbWFnZXM6IDksIHZpZGVvczogMCwgYXVkaW9zOiAzLCB0b3RhbDogMTIgfSxcbiAgICAgICAgc3VwcG9ydHNBdXRvbWF0aWNEdXJhdGlvbjogZmFsc2UsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNSwgbWF4OiAxNSwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDRfMDAwLFxuICAgICAgICBzdXBwb3J0c0F1ZGlvT25seVJlZmVyZW5jZXM6IHRydWUsXG4gICAgICAgIGZyYW1lUmVmZXJlbmNlc0V4Y2x1c2l2ZTogdHJ1ZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0VkaXQ6IGZhbHNlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRXh0ZW5kOiBmYWxzZSxcbiAgICAgICAgY29uZmlybWVkSW5wdXRSb2xlczogbW9vblJlZmVyZW5jZVJvbGVzLFxuICAgICAgICByZWZlcmVuY2VWaWRlb0R1cmF0aW9uU2Vjb25kczogeyBtaW46IDIsIG1heDogMzAgfSxcbiAgICAgICAgcmVmZXJlbmNlQXVkaW9EdXJhdGlvblNlY29uZHM6IHsgbWluOiAyLCBtYXg6IDMwIH0sXG4gICAgfSksXG4gICAgc2QybWluaTogY29udHJhY3Qoe1xuICAgICAgICBtb2RlbEFsaWFzOiAnc2QybWluaScsXG4gICAgICAgIGZhbWlseTogJ21vb24tYnVkZ2V0JyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzQ4MHAnOiB7IG1pbjogNSwgbWF4OiAxNSB9LCAnNzIwcCc6IHsgbWluOiA1LCBtYXg6IDEyIH0gfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzE2OjknLCAnOToxNicsICcxOjEnLCAnNDozJywgJzM6NCddLFxuICAgICAgICBtb2RlczogYWxsUmVmZXJlbmNlTW9kZXMsXG4gICAgICAgIHJlZmVyZW5jZUxpbWl0czogeyBpbWFnZXM6IDksIHZpZGVvczogMywgYXVkaW9zOiAzLCB0b3RhbDogMTUgfSxcbiAgICAgICAgc3VwcG9ydHNBdXRvbWF0aWNEdXJhdGlvbjogZmFsc2UsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNSwgbWF4OiAxNSwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDVfMDAwLFxuICAgICAgICBzdXBwb3J0c0F1ZGlvT25seVJlZmVyZW5jZXM6IHRydWUsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FZGl0OiBmYWxzZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0V4dGVuZDogZmFsc2UsXG4gICAgICAgIGNvbmZpcm1lZElucHV0Um9sZXM6IG1vb25SZWZlcmVuY2VSb2xlcyxcbiAgICB9KSxcbiAgICAnc2QyLTkzMC1mYWNlJzogY29udHJhY3Qoe1xuICAgICAgICBtb2RlbEFsaWFzOiAnc2QyLTkzMC1mYWNlJyxcbiAgICAgICAgZmFtaWx5OiAnbW9vbi1idWRnZXQnLFxuICAgICAgICByZXNvbHV0aW9uczogeyAnNzIwcCc6IHsgbWluOiA0LCBtYXg6IDMwIH0gfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzE2OjknLCAnOToxNicsICcxOjEnLCAnNDozJywgJzM6NCddLFxuICAgICAgICBtb2RlczogYWxsUmVmZXJlbmNlTW9kZXMsXG4gICAgICAgIHJlZmVyZW5jZUxpbWl0czogeyBpbWFnZXM6IDksIHZpZGVvczogMCwgYXVkaW9zOiAzLCB0b3RhbDogMTIgfSxcbiAgICAgICAgc3VwcG9ydHNBdXRvbWF0aWNEdXJhdGlvbjogZmFsc2UsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNCwgbWF4OiAzMCwgZGVmYXVsdDogNSB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDVfMDAwLFxuICAgICAgICBzdXBwb3J0c0F1ZGlvT25seVJlZmVyZW5jZXM6IHRydWUsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FZGl0OiBmYWxzZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0V4dGVuZDogZmFsc2UsXG4gICAgICAgIGNvbmZpcm1lZElucHV0Um9sZXM6IG1vb25SZWZlcmVuY2VSb2xlcyxcbiAgICB9KSxcbiAgICAnc2QyLjUtMzAtMTAtZmFjZSc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NkMi41LTMwLTEwLWZhY2UnLFxuICAgICAgICBmYW1pbHk6ICdtb29uLWJ1ZGdldCcsXG4gICAgICAgIHJlc29sdXRpb25zOiB7ICc3MjBwJzogeyBtaW46IDQsIG1heDogMzAgfSB9LFxuICAgICAgICBkZWZhdWx0UmVzb2x1dGlvbjogJzcyMHAnLFxuICAgICAgICBhc3BlY3RSYXRpb3M6IFsnMTY6OScsICc5OjE2JywgJzE6MScsICc0OjMnLCAnMzo0J10sXG4gICAgICAgIG1vZGVzOiBhbGxSZWZlcmVuY2VNb2RlcyxcbiAgICAgICAgcmVmZXJlbmNlTGltaXRzOiB7IGltYWdlczogMzAsIHZpZGVvczogMCwgYXVkaW9zOiAxMCwgdG90YWw6IDQwIH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IGZhbHNlLFxuICAgICAgICBkdXJhdGlvbjogeyBtaW46IDQsIG1heDogMzAsIGRlZmF1bHQ6IDUgfSxcbiAgICAgICAgbWF4UHJvbXB0TGVuZ3RoOiA1XzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uUmVmZXJlbmNlUm9sZXMsXG4gICAgfSksXG4gICAgJ3NkMi05MzAtZmFzdCc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NkMi05MzAtZmFzdCcsXG4gICAgICAgIGZhbWlseTogJ21vb24tYnVkZ2V0JyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzcyMHAnOiB7IG1pbjogNSwgbWF4OiAxNSB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNzIwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycxNjo5JywgJzk6MTYnLCAnMToxJywgJzQ6MycsICczOjQnXSxcbiAgICAgICAgbW9kZXM6IGFsbFJlZmVyZW5jZU1vZGVzLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiA5LCB2aWRlb3M6IDMsIGF1ZGlvczogMywgdG90YWw6IDE1IH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IGZhbHNlLFxuICAgICAgICBkdXJhdGlvbjogeyBtaW46IDUsIG1heDogMTUsIGRlZmF1bHQ6IDUgfSxcbiAgICAgICAgbWF4UHJvbXB0TGVuZ3RoOiA1XzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uUmVmZXJlbmNlUm9sZXMsXG4gICAgfSksXG4gICAgJ3NkMi05MzAtbm8tZmFjZSc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NkMi05MzAtbm8tZmFjZScsXG4gICAgICAgIGZhbWlseTogJ21vb24tYnVkZ2V0JyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzcyMHAnOiB7IG1pbjogNCwgbWF4OiAxNSB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNzIwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycxNjo5JywgJzk6MTYnLCAnMToxJywgJzQ6MycsICczOjQnXSxcbiAgICAgICAgbW9kZXM6IGFsbFJlZmVyZW5jZU1vZGVzLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiA5LCB2aWRlb3M6IDMsIGF1ZGlvczogMywgdG90YWw6IDE1IH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IGZhbHNlLFxuICAgICAgICBkdXJhdGlvbjogeyBtaW46IDQsIG1heDogMTUsIGRlZmF1bHQ6IDUgfSxcbiAgICAgICAgbWF4UHJvbXB0TGVuZ3RoOiA1XzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uUmVmZXJlbmNlUm9sZXMsXG4gICAgfSksXG4gICAgJ3NkMi41LTMwLTEwLTEwLTQ4MCc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NkMi41LTMwLTEwLTEwLTQ4MCcsXG4gICAgICAgIGZhbWlseTogJ21vb24tYnVkZ2V0JyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzQ4MHAnOiB7IG1pbjogNCwgbWF4OiAzMCB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNDgwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycxNjo5JywgJzk6MTYnLCAnMToxJywgJzQ6MycsICczOjQnXSxcbiAgICAgICAgbW9kZXM6IGFsbFJlZmVyZW5jZU1vZGVzLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiAzMCwgdmlkZW9zOiAxMCwgYXVkaW9zOiAxMCwgdG90YWw6IDUwIH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IGZhbHNlLFxuICAgICAgICBkdXJhdGlvbjogeyBtaW46IDQsIG1heDogMzAsIGRlZmF1bHQ6IDUgfSxcbiAgICAgICAgbWF4UHJvbXB0TGVuZ3RoOiA1XzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uUmVmZXJlbmNlUm9sZXMsXG4gICAgfSksXG4gICAgJ3NkMi41LTMwLTEwLTEwJzogY29udHJhY3Qoe1xuICAgICAgICBtb2RlbEFsaWFzOiAnc2QyLjUtMzAtMTAtMTAnLFxuICAgICAgICBmYW1pbHk6ICdtb29uLWJ1ZGdldCcsXG4gICAgICAgIHJlc29sdXRpb25zOiB7ICc3MjBwJzogeyBtaW46IDQsIG1heDogMzAgfSB9LFxuICAgICAgICBkZWZhdWx0UmVzb2x1dGlvbjogJzcyMHAnLFxuICAgICAgICBhc3BlY3RSYXRpb3M6IFsnMTY6OScsICc5OjE2JywgJzE6MScsICc0OjMnLCAnMzo0J10sXG4gICAgICAgIG1vZGVzOiBhbGxSZWZlcmVuY2VNb2RlcyxcbiAgICAgICAgcmVmZXJlbmNlTGltaXRzOiB7IGltYWdlczogMzAsIHZpZGVvczogMTAsIGF1ZGlvczogMTAsIHRvdGFsOiA1MCB9LFxuICAgICAgICBzdXBwb3J0c0F1dG9tYXRpY0R1cmF0aW9uOiBmYWxzZSxcbiAgICAgICAgZHVyYXRpb246IHsgbWluOiA0LCBtYXg6IDMwLCBkZWZhdWx0OiA1IH0sXG4gICAgICAgIG1heFByb21wdExlbmd0aDogNV8wMDAsXG4gICAgICAgIHN1cHBvcnRzQXVkaW9Pbmx5UmVmZXJlbmNlczogdHJ1ZSxcbiAgICAgICAgc3VwcG9ydHNWaWRlb0VkaXQ6IGZhbHNlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRXh0ZW5kOiBmYWxzZSxcbiAgICAgICAgY29uZmlybWVkSW5wdXRSb2xlczogbW9vblJlZmVyZW5jZVJvbGVzLFxuICAgIH0pLFxuICAgICdzZDIuNS0zMC0xMC0xMC1wZXItcmVxdWVzdCc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ3NkMi41LTMwLTEwLTEwLXBlci1yZXF1ZXN0JyxcbiAgICAgICAgZmFtaWx5OiAnbW9vbi1idWRnZXQnLFxuICAgICAgICByZXNvbHV0aW9uczogeyAnNzIwcCc6IHsgbWluOiA1LCBtYXg6IDMwIH0gfSxcbiAgICAgICAgZGVmYXVsdFJlc29sdXRpb246ICc3MjBwJyxcbiAgICAgICAgYXNwZWN0UmF0aW9zOiBbJzE2OjknLCAnOToxNicsICcxOjEnLCAnNDozJywgJzM6NCddLFxuICAgICAgICBtb2RlczogYWxsUmVmZXJlbmNlTW9kZXMsXG4gICAgICAgIHJlZmVyZW5jZUxpbWl0czogeyBpbWFnZXM6IDMwLCB2aWRlb3M6IDMsIGF1ZGlvczogMywgdG90YWw6IDM2IH0sXG4gICAgICAgIHN1cHBvcnRzQXV0b21hdGljRHVyYXRpb246IGZhbHNlLFxuICAgICAgICBkdXJhdGlvbjogeyBtaW46IDUsIG1heDogMzAsIGRlZmF1bHQ6IDUgfSxcbiAgICAgICAgbWF4UHJvbXB0TGVuZ3RoOiA1XzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uUmVmZXJlbmNlUm9sZXMsXG4gICAgfSksXG4gICAgJ2dyb2stdjEuNS12aWRlbyc6IGNvbnRyYWN0KHtcbiAgICAgICAgbW9kZWxBbGlhczogJ2dyb2stdjEuNS12aWRlbycsXG4gICAgICAgIGZhbWlseTogJ21vb24tZ3Jvay12MS41LXZpZGVvJyxcbiAgICAgICAgcmVzb2x1dGlvbnM6IHsgJzcyMHAnOiB7IG1pbjogNCwgbWF4OiAxNSB9LCAnMTA4MHAnOiB7IG1pbjogNCwgbWF4OiAxNSB9IH0sXG4gICAgICAgIGRlZmF1bHRSZXNvbHV0aW9uOiAnNzIwcCcsXG4gICAgICAgIGFzcGVjdFJhdGlvczogWycxNjo5JywgJzk6MTYnLCAnMToxJywgJzQ6MycsICczOjQnXSxcbiAgICAgICAgbW9kZXM6IFsndGV4dF90b192aWRlbycsICdmaXJzdF9mcmFtZScsICdvbW5pX3JlZmVyZW5jZSddLFxuICAgICAgICByZWZlcmVuY2VMaW1pdHM6IHsgaW1hZ2VzOiA3LCB2aWRlb3M6IDAsIGF1ZGlvczogMCwgdG90YWw6IDcgfSxcbiAgICAgICAgc3VwcG9ydHNBdXRvbWF0aWNEdXJhdGlvbjogZmFsc2UsXG4gICAgICAgIGR1cmF0aW9uOiB7IG1pbjogNCwgbWF4OiAxNSwgZGVmYXVsdDogNiB9LFxuICAgICAgICBtYXhQcm9tcHRMZW5ndGg6IDMyXzAwMCxcbiAgICAgICAgc3VwcG9ydHNBdWRpb09ubHlSZWZlcmVuY2VzOiBmYWxzZSxcbiAgICAgICAgZnJhbWVSZWZlcmVuY2VzRXhjbHVzaXZlOiB0cnVlLFxuICAgICAgICBzdXBwb3J0c1ZpZGVvRWRpdDogZmFsc2UsXG4gICAgICAgIHN1cHBvcnRzVmlkZW9FeHRlbmQ6IGZhbHNlLFxuICAgICAgICBjb25maXJtZWRJbnB1dFJvbGVzOiBtb29uR3Jva1JvbGVzLFxuICAgIH0pLFxufTtcbi8qKlxuICog6L+U5Zue57K+56GuIE1vb24g5qih5Z6L5ZCI5ZCM77yb5pyq55+l44CB5aSn5bCP5YaZ5LiN5ZCM5oiW5LuF55u45Ly855qE5Yir5ZCN5Z2H6L+U5ZueIHVuZGVmaW5lZOOAglxuICogQHBhcmFtIG1vZGVsQWxpYXMgTmV3IEFQSSDmqKHlnovnm67lvZXkuK3nmoTnsr7noa7mqKHlnosgSUTjgIJcbiAqIEByZXR1cm5zIOWFseS6q+aooeWei+WQiOWQjO+8jOaIluacquehruiupOaXtueahCB1bmRlZmluZWTjgIJcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1vb25WaWRlb0NvbnRyYWN0Rm9yTW9kZWwobW9kZWxBbGlhcykge1xuICAgIGNvbnN0IGV4YWN0ID0gbW9kZWxBbGlhcz8udHJpbSgpO1xuICAgIHJldHVybiBleGFjdCAmJiBPYmplY3QuaGFzT3duKE1PT05fVklERU9fQ09OVFJBQ1RTLCBleGFjdClcbiAgICAgICAgPyBNT09OX1ZJREVPX0NPTlRSQUNUU1tleGFjdF1cbiAgICAgICAgOiB1bmRlZmluZWQ7XG59XG4vKiog5Y+q6K+75pq06Zyy5bey56Gu6K6k55qE57K+56Gu5qih5Z6LIElE77yM5L6b55uu5b2V5Zue5b2S5ZKM5a6/5Li76aKE5qOA5L2/55So44CCICovXG5leHBvcnQgY29uc3QgbW9vblZpZGVvTW9kZWxBbGlhc2VzID0gT2JqZWN0LmZyZWV6ZShPYmplY3Qua2V5cyhNT09OX1ZJREVPX0NPTlRSQUNUUykuc29ydCgpKTtcbiJdLCJtYXBwaW5ncyI6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
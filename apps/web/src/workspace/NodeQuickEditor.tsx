import {
  Expand,
  EyeOff,
  GitFork,
  ImageOff,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';

import type {
  Asset,
  PortRole,
  PromptDocument,
  PromptSkill,
  VideoCompletionAction,
  VideoModelFamily,
  VideoMode,
} from '@multimodal-canvas/domain';
import {
  DEFAULT_GENERATION_COUNT,
  GENERATION_COUNT_MAX,
  displayVideoMode,
  imageEditCapability,
  implementedVideoModes,
  isValidGenerationCount,
  resolveVideoCompletionAction,
  videoFamilyForModel,
  videoModeCapability,
  videoModeDescriptions,
  videoModeLabels,
  videoModes,
} from '@multimodal-canvas/domain';
import { renderPromptDocument } from '@multimodal-canvas/domain';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { AssetPreview } from './AssetPreview';
import { canForkNewNode, canRunSameNode, nodeHasPrompt } from './fork-generate-node';
import {
  imageEditSourcePreviewAsset,
  type ImageEditSourcePreview,
} from './image-edit-source-preview';
import { useWorkspacePreferences } from '../state/workspace-preferences';
import { CompactSelect } from './CompactSelect';
import { PromptSkillPanel } from './PromptSkillPanel';
import { useFloatingParameterMenu } from './use-floating-parameter-menu';
import { isImeKeyboardEvent } from '../ime';
import './node-quick-editor.css';
import './node-quick-editor-layout.css';
import { mediaLabels, type ModelEntry, type ModelSelection } from './contracts';

/**
 * 模型目录声明的推理强度标识。
 *
 * 不同模型可能使用 `low`、`xhigh`、`max` 或其他供应商自定义值，
 * 因此这里不能再收窄成固定的联合类型。
 */
export type InferenceStrength = string;

/**
 * 生成节点可配置的媒体参数。
 * 未识别的字段会原样保留，便于不同模型在父层扩展自己的参数。
 */
export type NodeMediaParameters = Record<string, unknown> & {
  size?: string;
  quality?: string;
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  /** 保留历史视频宽度，单位像素；界面不再编辑，新建不初始化。 */
  width?: number;
  /** 保留历史视频高度，单位像素；界面不再编辑，新建不初始化。 */
  height?: number;
  /** TTS 音色标识，允许平台自定义非空字符串，必须由用户显式填写。 */
  voice?: string;
  /** TTS 输出格式；新建或切换模型时可初始化为支持列表中的第一项，清空后省略。 */
  response_format?: string;
  /** TTS 语速倍率，有限数值且范围为 0.25 至 4；未设置时省略。 */
  speed?: number;
};

/** 节点提示词、模型与媒体参数编辑器的受控输入和操作回调。 */
export type NodeQuickEditorProps = {
  node: AssetFlowNode;
  /** 优化任务所属项目；未加载项目时只允许选择技能，不发起请求。 */
  projectId?: string;
  /** 当前用户共用目录；包含内置及自定义技能。 */
  promptSkills?: readonly PromptSkill[];
  /** 打开技能管理工作台。 */
  onOpenSkillWorkbench?: () => void;
  /** 目录加载状态错误时阻止提交，避免使用旧的自定义定义。 */
  skillLibraryError?: string;
  /** 目录读取中保留已保存的选择，不能将尚未返回的技能视为已删除。 */
  skillLibraryLoading?: boolean;
  /** 保存节点选择的技能，清空表示不使用。 */
  onPromptSkillChange?: (skillId: string | undefined) => void;
  models: ModelEntry[];
  busy: boolean;
  /** 旧纯文本提示词回调；有结构化回调时可省略。 */
  onPromptChange?: (value: string) => void;
  /** 保存节点的结构化提示词文档。 */
  onPromptDocumentChange?: (document: PromptDocument) => void;
  /** 提示词资源条点击上传后，把本地文件收成项目资源。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 当前项目可访问资源，用于提示词中的 `@` 搜索。 */
  assets?: readonly Asset[];
  onModelChange: (value: ModelSelection) => void;
  onInferenceStrengthChange: (value: InferenceStrength) => void;
  onRun: () => void;
  /** 有回显时把修改结果写到新建子节点并立刻运行。 */
  onRunNewNode?: () => void;
  /** 当前节点是否有可供转换/生成的连线输入。 */
  hasConnectedInput?: boolean;
  /** 显式连接到当前节点的输入文件，供完整编辑器展示。 */
  connectedAssets?: readonly (Pick<Asset, 'id' | 'name' | 'mediaType'> &
    Partial<Pick<Asset, 'contentUrl' | 'mimeType'>>)[];
  /** 更新节点的媒体参数；未提供时参数控件仍可显示但不会修改父状态。 */
  onParametersChange?: (value: NodeMediaParameters) => void;
  /** 保存本次操作的生成份数，范围为 1 至 20；不作为 Provider 参数发送。 */
  onGenerationCountChange?: (value: number) => void;
  /** 更新视频完成后的末帧动作。 */
  onCompletionActionChange?: (value: VideoCompletionAction) => void;
  /** 指定填充目标图片节点。 */
  onCompletionTargetNodeIdChange?: (value: string | undefined) => void;
  /** 可被末帧填充的空图片节点。 */
  emptyImageNodes?: readonly { id: string; label: string }[];
  /** 当前连到该节点的输入角色，用于旧视频节点回显推断出的模式。 */
  connectedInputRoles?: readonly PortRole[];
  /** 更新视频生成模式；切换后由父层裁掉不兼容连线。 */
  onVideoModeChange?: (value: VideoMode) => void;
  /**
   * 图片编辑节点的只读来源图。存在时编辑器显示专用文案与原图缩略图，
   * 且不允许在此修改来源节点内容。
   */
  imageEditSource?: ImageEditSourcePreview;
  /**
   * 点击来源图名称时定位到来源节点。
   * @param sourceNodeId 来源画布节点 ID。
   */
  onFocusImageEditSource?: (sourceNodeId: string) => void;
};

/** 图片编辑节点上只读展示的来源图身份。 */
export type { ImageEditSourcePreview } from './image-edit-source-preview';

/** 模型声明的选项及其可见说明，保留供应商给出的值和顺序。 */
type MediaOption = {
  value: string;
  label: string;
  description?: string;
  previewAspectRatio?: string;
  disabled?: boolean;
};

/** 可按模型来源分组的媒体选项。 */
type QuickOption = MediaOption & {
  groupLabel?: string;
};

const imageQualityOptions: MediaOption[] = [
  { value: '1k', label: '1K', description: '标准' },
  { value: '2k', label: '2K', description: '高清' },
  { value: '3k', label: '3K', description: '超清' },
  { value: '4k', label: '4K', description: '极致' },
];

const videoResolutionOptions: MediaOption[] = [
  '360p',
  '480p',
  '720p',
  '1080p',
  '1440p',
  '2160p',
].map((value) => ({ value, label: value }));

const aspectRatioOptions: MediaOption[] = [
  { value: '1:1', label: '1:1', description: '方形', previewAspectRatio: '1 / 1' },
  { value: '16:9', label: '16:9', description: '横屏', previewAspectRatio: '16 / 9' },
  { value: '9:16', label: '9:16', description: '竖屏', previewAspectRatio: '9 / 16' },
  { value: '4:3', label: '4:3', description: '标准横向', previewAspectRatio: '4 / 3' },
  { value: '3:4', label: '3:4', description: '标准竖向', previewAspectRatio: '3 / 4' },
  { value: '3:2', label: '3:2', description: '摄影横向', previewAspectRatio: '3 / 2' },
  { value: '2:3', label: '2:3', description: '摄影竖向', previewAspectRatio: '2 / 3' },
  { value: '21:9', label: '21:9', description: '超宽屏', previewAspectRatio: '21 / 9' },
];

const aspectRatioDescriptions: Record<string, string> = Object.fromEntries(
  aspectRatioOptions.map((option) => [option.value, option.description ?? '']),
);

/** Wan3 与 Seedance 2.x 用 -1 表示由模型根据输入自动决定时长。 */
const automaticVideoDurationOption: MediaOption = {
  value: '-1',
  label: '自动',
  description: '由模型根据输入决定',
};

/** 自动比例按模型根据提示词和输入素材决定；强制沿用素材的模式另显示原素材标签。 */
const adaptiveVideoAspectRatioOption: MediaOption = {
  value: 'adaptive',
  label: '自动比例',
  description: '由模型根据提示词和素材决定',
};

/** 判断模型家族是否接受 -1 自动时长。 */
function supportsAutomaticVideoDuration(family: VideoModelFamily): boolean {
  return family === 'wan3' || family === 'seedance-2' || family === 'seedance-2.5';
}

/** Wan3 与 Seedance 2.x 可显式选择 adaptive 比例。 */
function supportsAdaptiveVideoAspectRatio(family: VideoModelFamily): boolean {
  return family === 'wan3' || family === 'seedance-2' || family === 'seedance-2.5';
}

/** 只有这些不与 Doubao 共用的精确 ID 使用 Moon Seedance 编辑合同。 */
const moonSeedanceModelIds = new Set([
  'seedance-2-0-mini-official',
  'seedance-2-0-fast-official',
  'seedance-2-0-official',
]);

/** 判断模型是否使用 Moon Seedance 的编辑与延长合同。 */
function isMoonSeedanceModel(modelAlias?: string): boolean {
  return moonSeedanceModelIds.has(modelAlias?.trim() ?? '');
}

/** 官方合同要求沿用原素材比例的模式。 */
function requiresAdaptiveVideoAspectRatio(
  family: VideoModelFamily,
  mode?: VideoMode,
  modelAlias?: string,
): boolean {
  return (
    (family === 'wan3' && mode === 'video_extend') ||
    (isMoonSeedanceModel(modelAlias) && (mode === 'video_edit' || mode === 'video_extend')) ||
    (family === 'seedance-2.5' &&
      ['first_frame', 'first_last_frame', 'video_edit', 'video_extend'].includes(mode ?? ''))
  );
}

/** 已确认的官方视频时长边界；菜单仅列常用值，自定义输入仍可填写区间内整数。 */
const videoDurationContracts: Partial<
  Record<VideoModelFamily, { min: number; max: number; presets: readonly number[] }>
> = {
  'moon-minimax-h3': { min: 4, max: 15, presets: [4, 8, 12, 15] },
  'minimax-h3': { min: 4, max: 15, presets: [4, 8, 12, 15] },
  wan3: { min: 2, max: 30, presets: [2, 4, 8, 12, 15, 20, 30] },
  'seedance-2': { min: 4, max: 15, presets: [4, 8, 12, 15] },
  'seedance-2.5': { min: 4, max: 30, presets: [4, 8, 12, 15, 20, 30] },
};

/** 已确认的官方分辨率白名单；目录缺失或含旧值时仍以 Provider 合同为准。 */
const videoResolutionContracts: Partial<Record<VideoModelFamily, readonly string[]>> = {
  'minimax-h3': ['768p', '2k'],
  wan3: ['480p', '720p', '1080p'],
  'seedance-2': ['480p', '720p', '1080p', '4k'],
  'seedance-2.5': ['480p', '720p', '1080p'],
};

/** Moon H3 普通工作流可映射为精确像素尺寸的清晰度。 */
const moonH3StandardResolutions = ['480p', '768p', '1080p'] as const;
/** Moon H3 参考工作流在普通档位之外支持的超分档位。 */
const moonH3SuperResolutions = [...moonH3StandardResolutions, '2k', '4k'] as const;
/** Moon H3 尺寸目录明确支持的固定比例，不能使用 adaptive。 */
const moonH3FixedAspectRatios = [
  '16:9',
  '9:16',
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '21:9',
] as const;

/** 返回模型和模式的分辨率范围；未知模型交由目录决定。 */
function videoResolutionContractForModel(
  modelAlias?: string,
  allowMoonH3SuperResolution = false,
): readonly string[] | undefined {
  const family = videoFamilyForModel(modelAlias);
  if (family === 'moon-minimax-h3') {
    return allowMoonH3SuperResolution ? moonH3SuperResolutions : moonH3StandardResolutions;
  }
  if (family === 'seedance-2' && /-(?:fast|mini)-/.test(modelAlias?.toLowerCase() ?? '')) {
    return ['480p', '720p'];
  }
  return videoResolutionContracts[family];
}

/** Provider 已支持的 TTS 格式，空选项仅用于移除显式配置。 */
const AUDIO_FORMAT_OPTIONS: MediaOption[] = [
  { value: '', label: '未设置' },
  ...['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((value) => ({
    value,
    label: value.toUpperCase(),
  })),
];

/** 与 Provider 契约一致的连续语速范围，不将用户值静默截断或量化。 */
const AUDIO_SPEED_RANGE = { min: 0.25, max: 4 } as const;

/** GPT-5.6 文本模型支持的推理强度，目录缺失时作为兼容回退。 */
const GPT_56_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** 上一版兼容回退使用的档位，展示时迁移到当前的 low 到 Ultra。 */
const LEGACY_GPT_56_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 推理强度的用户界面标签，值仍按供应商契约原样提交。 */
const INFERENCE_STRENGTH_LABELS: Record<string, string> = {
  low: '轻度',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
  ultra: 'Ultra',
};

/** GPT-5.6 系列模型可带供应商自定义后缀，仍使用相同的推理强度菜单。 */
const GPT_56_TEXT_MODEL_ALIAS_PATTERN = /^gpt-5\.6(?:$|[-_.])/;

/** 渲染选中生成节点的紧凑编辑器。 */
export function NodeQuickEditor({
  node,
  projectId,
  promptSkills,
  onOpenSkillWorkbench,
  skillLibraryError,
  skillLibraryLoading,
  onPromptSkillChange,
  models,
  busy,
  onPromptChange,
  onPromptDocumentChange,
  onUploadResource,
  assets = [],
  onModelChange,
  onInferenceStrengthChange,
  onRun,
  onRunNewNode,
  hasConnectedInput = false,
  connectedAssets = [],
  onParametersChange,
  onGenerationCountChange,
  onCompletionActionChange,
  onCompletionTargetNodeIdChange,
  emptyImageNodes = [],
  connectedInputRoles = [],
  onVideoModeChange,
  imageEditSource,
  onFocusImageEditSource,
}: NodeQuickEditorProps) {
  const showImageEditSourceCard = useWorkspacePreferences((state) => state.showImageEditSourceCard);
  const setShowImageEditSourceCard = useWorkspacePreferences(
    (state) => state.setShowImageEditSourceCard,
  );
  /** 参数页只改变展示状态，不修改节点或默认参数。 */
  const [mediaSettingsOpen, setMediaSettingsOpen] = useState(false);
  /** 同一节点在快速面板和 Dialog 之间共用父层保存的文档。 */
  const [expandedEditorOpen, setExpandedEditorOpen] = useState(false);
  /** 关闭浮层后恢复键盘焦点的触发器。 */
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const expandTriggerRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  /** 点击或键盘打开后固定至显式关闭。 */
  const settingsPinnedRef = useRef(false);
  const settingsCloseTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(settingsCloseTimerRef.current), []);

  /** 仅改变展示状态，关闭时取消仍在等待的定时器。 */
  const closeMediaSettings = () => {
    clearTimeout(settingsCloseTimerRef.current);
    settingsPinnedRef.current = false;
    setMediaSettingsOpen(false);
  };
  /** 点击或键盘打开参数页。 */
  const enterMediaSettings = () => {
    clearTimeout(settingsCloseTimerRef.current);
    setMediaSettingsOpen(true);
  };
  /** Tab 移出整个参数区域时关闭，区域内部移动焦点不影响菜单。 */
  const blurMediaSettings = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!settingsRef.current?.contains(next) && !settingsTriggerRef.current?.contains(next)) {
      closeMediaSettings();
    }
  };
  const settingsId = useId();
  /** 参数页与模型菜单同处浏览器顶层，不受编辑器最大高度滚动容器裁切。 */
  const settingsStyle = useFloatingParameterMenu({
    anchorRef: settingsTriggerRef,
    menuRef: settingsRef,
    enabled: node.data.mediaType !== 'text',
    open: mediaSettingsOpen,
    placement: 'top',
  });
  const dialogTitleId = useId();
  /** Dialog 的关闭动画结束前外层控件会重新挂载，随后恢复展开按钮焦点。 */
  const wasExpandedRef = useRef(false);
  useEffect(() => {
    const restore = wasExpandedRef.current && !expandedEditorOpen;
    wasExpandedRef.current = expandedEditorOpen;
    if (!restore) return;
    const timer = window.setTimeout(() => expandTriggerRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [expandedEditorOpen]);

  useEffect(() => {
    if (!mediaSettingsOpen) return;
    /** 点击参数页与触发器外部时关闭，不影响页内参数菜单。 */
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !settingsRef.current?.contains(event.target) &&
        !settingsTriggerRef.current?.contains(event.target)
      ) {
        settingsPinnedRef.current = false;
        clearTimeout(settingsCloseTimerRef.current);
        setMediaSettingsOpen(false);
      }
    };
    /** 悬停时焦点可留在提示词；子菜单展开时优先由子菜单消费 Escape。 */
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyboardEvent(event)) return;
      if (settingsRef.current?.querySelector('[aria-expanded="true"]')) return;
      event.preventDefault();
      settingsPinnedRef.current = false;
      clearTimeout(settingsCloseTimerRef.current);
      setMediaSettingsOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [mediaSettingsOpen]);
  const storedModelAlias = node.data.modelAlias ?? '';
  const currentCredentialId = node.data.credentialId;
  const currentPlatformModelId = node.data.platformModelId;
  const availableModels = models.filter((model) => model.mediaTypes.includes(node.data.mediaType));
  const selectedModel = findSelectedModel(
    availableModels,
    storedModelAlias,
    currentCredentialId,
    currentPlatformModelId,
  );
  const currentModel =
    currentPlatformModelId && selectedModel ? selectedModel.id : storedModelAlias;
  const modelIssue = currentPlatformModelId
    ? !selectedModel
      ? '当前平台模型已下架，请选择其他模型'
      : selectedModel.availability && selectedModel.availability !== 'available'
        ? '当前平台模型暂不可用，请选择其他模型'
        : undefined
    : availableModels.some((model) => model.platformModelId)
      ? '请先选择平台模型'
      : undefined;
  const currentModelIsMissing =
    Boolean(currentModel) &&
    !availableModels.some((model) =>
      currentPlatformModelId
        ? model.platformModelId === currentPlatformModelId
        : !model.platformModelId &&
          model.id === currentModel &&
          model.credentialId === currentCredentialId,
    );
  const currentModelValue = currentModel
    ? modelOptionValue({
        modelAlias: currentModel,
        credentialId: currentCredentialId,
        platformModelId: currentPlatformModelId,
      })
    : '';
  const modelOptions = buildModelOptions(
    availableModels,
    currentModelValue,
    currentModel,
    currentCredentialId,
    currentModelIsMissing,
  );
  const parameters = readNodeMediaParameters(node.data);
  const videoFamily = videoFamilyForModel(currentModel);
  const currentVideoMode =
    node.data.mediaType === 'video' ? displayVideoMode(node.data, connectedInputRoles) : undefined;
  const allowMoonH3SuperResolution = Boolean(
    currentVideoMode &&
    ['first_frame', 'first_last_frame', 'omni_reference'].includes(currentVideoMode),
  );
  const supportsAutomaticDuration = supportsAutomaticVideoDuration(videoFamily);
  const supportsAdaptiveAspectRatio = supportsAdaptiveVideoAspectRatio(videoFamily);
  /** 无效输入只留在当前草稿，修正前不改写已保存数量，也不能发起运行。 */
  const [generationCountDraft, setGenerationCountDraft] = useState(
    String(node.data.generationCount ?? DEFAULT_GENERATION_COUNT),
  );
  /** 自定义时长允许清空；空值保留供应商默认语义，非空值只接受正整数秒。 */
  const [durationDraft, setDurationDraft] = useState(
    parameters.duration === undefined ? '' : String(parameters.duration),
  );
  useEffect(() => {
    setGenerationCountDraft(String(node.data.generationCount ?? DEFAULT_GENERATION_COUNT));
  }, [node.id, node.data.generationCount]);
  useEffect(() => {
    setDurationDraft(parameters.duration === undefined ? '' : String(parameters.duration));
  }, [node.id, parameters.duration]);
  const generationCountIssue = isValidGenerationCount(Number(generationCountDraft))
    ? undefined
    : `生成数量必须为 1 至 ${GENERATION_COUNT_MAX} 的整数`;
  const durationContract = videoDurationContracts[videoFamily];
  const durationValue = Number(durationDraft);
  const automaticDuration = supportsAutomaticDuration && durationValue === -1;
  const durationIssue =
    node.data.mediaType === 'video' &&
    durationDraft !== '' &&
    (!Number.isSafeInteger(durationValue) ||
      (!automaticDuration &&
        (durationValue <= 0 ||
          Boolean(
            durationContract &&
            (durationValue < durationContract.min || durationValue > durationContract.max),
          ))))
      ? durationContract
        ? `视频时长必须为 ${durationContract.min} 至 ${durationContract.max} 秒${supportsAutomaticDuration ? '，或使用 -1 自动时长' : ''}`
        : supportsAutomaticDuration
          ? '视频时长必须为正整数秒，或使用 -1 自动时长'
          : '视频时长必须为正整数秒，且不能超过安全整数范围'
      : undefined;
  const resolutionContract = videoResolutionContractForModel(
    currentModel,
    allowMoonH3SuperResolution,
  );
  const resolution = normalizeCurrentOptionValue(parameters.resolution).toLowerCase();
  const resolutionIssue =
    node.data.mediaType === 'video' &&
    resolution &&
    resolutionContract &&
    !resolutionContract.includes(resolution)
      ? videoFamily === 'moon-minimax-h3'
        ? currentVideoMode === 'text_to_video'
          ? 'Moon MiniMax H3 文生视频清晰度仅支持 480P、768P 或 1080P'
          : `Moon MiniMax H3 当前模式清晰度仅支持 ${resolutionContract.map((value) => value.toUpperCase()).join('、')}`
        : videoFamily === 'minimax-h3'
          ? 'MiniMax H3 视频清晰度仅支持 768P 或 2K'
          : videoFamily === 'wan3'
            ? 'Wan3 视频清晰度仅支持 480P、720P 或 1080P'
            : `Seedance 视频清晰度仅支持 ${resolutionContract.map((value) => value.toUpperCase()).join('、')}`
      : undefined;
  const catalogMediaOptions = getMediaOptions(
    selectedModel,
    node.data.mediaType,
    parameters,
    true,
    currentModel,
    allowMoonH3SuperResolution,
  );
  const requiresAdaptiveAspectRatio = requiresAdaptiveVideoAspectRatio(
    videoFamily,
    currentVideoMode,
    currentModel,
  );
  const aspectRatioIssue =
    node.data.mediaType === 'video' && videoFamily === 'moon-minimax-h3' && !parameters.aspectRatio
      ? 'Moon MiniMax H3 必须选择固定视频比例'
      : node.data.mediaType === 'video' &&
          catalogMediaOptions.aspectRatio.some(
            (option) => option.value === parameters.aspectRatio && option.disabled,
          )
        ? `当前模型不支持视频比例 ${parameters.aspectRatio}`
        : undefined;
  const mediaOptions = {
    ...catalogMediaOptions,
    duration: supportsAutomaticDuration
      ? [
          ...catalogMediaOptions.duration.filter((option) => option.value !== '-1'),
          automaticVideoDurationOption,
        ]
      : catalogMediaOptions.duration,
    aspectRatio: supportsAdaptiveAspectRatio
      ? [
          {
            ...adaptiveVideoAspectRatioOption,
            ...(node.data.videoMode === 'first_frame' || node.data.videoMode === 'first_last_frame'
              ? { label: '原图比例', description: '沿用输入图片' }
              : node.data.videoMode === 'video_edit' || node.data.videoMode === 'video_extend'
                ? { label: '原视频比例', description: '沿用输入视频' }
                : {}),
          },
          ...catalogMediaOptions.aspectRatio.filter((option) => option.value !== 'adaptive'),
        ]
      : catalogMediaOptions.aspectRatio,
  };
  const videoContractParameterIssue =
    node.data.mediaType === 'video' &&
    currentVideoMode === 'video_edit' &&
    (videoFamily === 'seedance-2.5' || isMoonSeedanceModel(currentModel)) &&
    (parameters.duration !== -1 || parameters.aspectRatio !== 'adaptive')
      ? 'Seedance 视频编辑需要自动时长和原视频比例'
      : node.data.mediaType === 'video' &&
          requiresAdaptiveAspectRatio &&
          parameters.aspectRatio !== 'adaptive'
        ? node.data.videoMode === 'first_frame' || node.data.videoMode === 'first_last_frame'
          ? 'Seedance 2.5 首帧和首尾帧需要沿用原图比例'
          : '视频编辑或延长需要沿用原视频比例'
        : undefined;
  const inferenceOptions = getInferenceStrengthOptions(
    selectedModel,
    node.data.mediaType,
    currentModel,
    node.data.inferenceStrength,
  );
  const enabled = node.data.enabled !== false;
  const effectivePrompt = node.data.promptDocument
    ? renderPromptDocument(node.data.promptDocument)
    : (node.data.prompt ?? '');
  const hasPrompt = Boolean(effectivePrompt.trim());
  /** 图片编辑必须由用户写明修改意图，不能靠连线输入代替提示词。 */
  const imageEditPromptRequired = Boolean(imageEditSource);
  const hasRunnableParameters = imageEditPromptRequired
    ? hasPrompt
    : hasPrompt || hasConnectedInput;
  const invalidVideoDimensions = (['width', 'height'] as const).filter((field) => {
    const value = parameters[field];
    return (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    );
  });
  /** 资源提及和原图连线都需要编辑接口；缺少目录声明不阻止提交。 */
  const hasImageEditInput =
    node.data.mediaType === 'image' &&
    (Boolean(imageEditSource) ||
      Boolean(
        node.data.promptDocument?.blocks.some(
          (block) => block.type === 'mention' && block.mediaType === 'image',
        ),
      ));
  const imageEditSourceIssue = imageEditSource?.versionUnavailable
    ? '来源图已不可读取或版本已变更，请重新从图片节点创建修改节点'
    : hasImageEditInput && imageEditCapability(selectedModel).unsupported
      ? '当前模型明确不支持图片编辑，请更换模型后再运行'
      : undefined;
  const mediaParameterIssue =
    durationIssue ??
    resolutionIssue ??
    aspectRatioIssue ??
    videoContractParameterIssue ??
    (node.data.mediaType === 'audio'
      ? getAudioParameterIssue(parameters, selectedModel)
      : node.data.mediaType === 'video' && invalidVideoDimensions.length > 0
        ? '视频宽高必须为正整数像素，且不能超过安全整数范围'
        : imageEditSourceIssue);

  const updateParameter = (key: keyof NodeMediaParameters, value: unknown) => {
    if (!onParametersChange) return;
    const next = { ...parameters };
    if (value === undefined || value === '') {
      delete next[key];
    } else {
      next[key] = value;
    }
    onParametersChange(next);
  };

  /** 推理强度对文字节点直接显示，对媒体节点收进参数页。 */
  const inferenceEditor =
    inferenceOptions.length > 0 ? (
      <CompactSelect
        label="推理强度"
        value={node.data.inferenceStrength}
        options={inferenceOptions}
        onChange={onInferenceStrengthChange}
        className="node-quick-editor-select-group"
        placement="top"
        floating
      />
    ) : null;

  const promptEditor = (
    <label className="node-quick-editor-field node-quick-editor-prompt">
      <TextPromptEditor
        nodeId={node.id}
        value={node.data.prompt ?? ''}
        promptDocument={node.data.promptDocument}
        assets={assets}
        connectedAssets={connectedAssets}
        placeholder={
          imageEditSource ? '想用这张图修改什么？例如：换成夜景、去掉背景' : '描述你想生成的内容'
        }
        ariaLabel={imageEditSource ? '图片修改要求' : '提示词'}
        onChange={onPromptDocumentChange ? undefined : onPromptChange}
        onDocumentChange={onPromptDocumentChange}
        onUploadResource={onUploadResource}
      />
    </label>
  );

  /** 与提示词编辑器共用结构化文档，采用时走现有历史和保存回调。 */
  const skillPanel = (
    <PromptSkillPanel
      nodeId={node.id}
      projectId={projectId}
      mediaType={node.data.mediaType}
      promptDocument={
        node.data.promptDocument ?? {
          version: 1,
          blocks: [{ type: 'text', text: node.data.prompt ?? '' }],
        }
      }
      skillId={node.data.promptSkillId}
      skills={promptSkills}
      skillsLoading={skillLibraryLoading}
      onOpenWorkbench={onOpenSkillWorkbench}
      models={models}
      disabled={busy || !onPromptSkillChange || Boolean(skillLibraryError)}
      onSkillChange={(id) => onPromptSkillChange?.(id)}
      onApply={(document) => {
        if (onPromptDocumentChange) onPromptDocumentChange(document);
        else onPromptChange?.(renderPromptDocument(document));
      }}
    />
  );

  /** 来源图只读展示：点击缩略图预览，点击名称定位到来源节点。 */
  const sourcePreviewAsset = imageEditSource
    ? imageEditSourcePreviewAsset(imageEditSource)
    : undefined;
  const imageEditSourcePreview =
    imageEditSource && showImageEditSourceCard ? (
      <div className="node-quick-editor-image-edit-source" role="group" aria-label="来源图（只读）">
        {sourcePreviewAsset ? (
          <AssetPreview
            asset={sourcePreviewAsset}
            mode="compact"
            interactive={false}
            allowOpen
            mediaClickPreviewEnabled
            className="node-quick-editor-image-edit-thumb"
          />
        ) : (
          <span
            className="node-quick-editor-image-edit-thumb is-missing"
            role="img"
            aria-label={`来源图不可用：${imageEditSource.name}`}
          >
            <ImageOff size={18} aria-hidden="true" />
          </span>
        )}
        <span className="node-quick-editor-image-edit-meta">
          <button
            type="button"
            className="node-quick-editor-image-edit-name nodrag nopan"
            onClick={() => onFocusImageEditSource?.(imageEditSource.sourceNodeId)}
          >
            {imageEditSource.name}
          </button>
          <span>
            来源图固定版本：
            {imageEditSource.version ? `v${imageEditSource.version}` : '运行前冻结'}
          </span>
        </span>
        <button
          type="button"
          className="node-quick-editor-image-edit-hide nodrag nopan"
          aria-label="隐藏来源图"
          title="隐藏来源图"
          onClick={() => setShowImageEditSourceCard(false)}
        >
          <EyeOff size={15} aria-hidden="true" />
        </button>
      </div>
    ) : null;

  /** 模式切换与其强制参数属于同一用户动作，避免 Provider 端静默改写。 */
  const changeVideoMode = (nextMode: VideoMode) => {
    const nextParameters = { ...parameters };
    let parametersChanged = false;
    if (
      nextMode === 'video_edit' &&
      (videoFamily === 'seedance-2.5' || isMoonSeedanceModel(currentModel))
    ) {
      if (nextParameters.duration !== -1) {
        nextParameters.duration = -1;
        parametersChanged = true;
      }
      if (nextParameters.aspectRatio !== 'adaptive') {
        nextParameters.aspectRatio = 'adaptive';
        parametersChanged = true;
      }
    } else {
      if (currentVideoMode === 'video_edit' && nextParameters.duration === -1) {
        const fallback = catalogMediaOptions.duration.find((option) => {
          const seconds = Number(option.value);
          return !option.disabled && Number.isSafeInteger(seconds) && seconds > 0;
        });
        if (fallback) nextParameters.duration = Number(fallback.value);
        else delete nextParameters.duration;
        parametersChanged = true;
      }
      if (requiresAdaptiveVideoAspectRatio(videoFamily, nextMode, currentModel)) {
        if (nextParameters.aspectRatio !== 'adaptive') {
          nextParameters.aspectRatio = 'adaptive';
          parametersChanged = true;
        }
      } else if (nextParameters.aspectRatio === 'adaptive') {
        const fallback = catalogMediaOptions.aspectRatio.find(
          (option) => !option.disabled && option.value !== 'adaptive',
        );
        if (fallback) nextParameters.aspectRatio = fallback.value;
        else delete nextParameters.aspectRatio;
        parametersChanged = true;
      }
    }
    if (parametersChanged) {
      setDurationDraft(
        nextParameters.duration === undefined ? '' : String(nextParameters.duration),
      );
      onParametersChange?.(nextParameters);
    }
    onVideoModeChange?.(nextMode);
  };

  /** 视频模式在快速编辑器控制栏常驻，避免用户为切换模式打开参数页。 */
  const videoModeEditor =
    node.data.mediaType === 'video' ? (
      <CompactSelect
        label="生成模式"
        value={displayVideoMode(node.data, connectedInputRoles)}
        options={videoModes.map((mode) => {
          const capability = videoModeCapability(mode, node.data.modelAlias);
          const implemented = (implementedVideoModes as readonly VideoMode[]).includes(mode);
          return {
            value: mode,
            label: videoModeLabels[mode],
            description: capability.reason ?? videoModeDescriptions[mode],
            disabled: !implemented || !capability.selectable,
          };
        })}
        onChange={(value) => changeVideoMode(value as VideoMode)}
        className="node-quick-editor-select-group node-quick-editor-video-mode"
        placement="top"
        floating
      />
    ) : null;

  const mediaParameterEditor = (
    <div className="node-quick-editor-media-settings">
      {imageEditSource ? (
        <label className="node-quick-editor-source-card-toggle">
          <input
            type="checkbox"
            checked={showImageEditSourceCard}
            onChange={(event) => setShowImageEditSourceCard(event.target.checked)}
            aria-label="显示来源图"
          />
          显示来源图
        </label>
      ) : null}
      {node.data.mediaType === 'image' && (
        <div
          className="node-quick-editor-media-options"
          data-columns="2"
          role="group"
          aria-label="媒体参数"
        >
          <CompactSelect
            label="图片清晰度"
            value={normalizeCurrentOptionValue(parameters.quality)}
            options={mediaOptions.quality}
            onChange={(value) => updateParameter('quality', value)}
            className="node-quick-editor-select-group"
            placement="top"
            optionLayout="grid"
            floating
          />
          <QuickOptionMenu
            label="图片比例"
            value={parameters.aspectRatio}
            options={mediaOptions.aspectRatio}
            aspectOptions
            onChange={(value) => updateParameter('aspectRatio', value)}
          />
        </div>
      )}

      {node.data.mediaType === 'video' && (
        <>
          <div
            className="node-quick-editor-media-options"
            data-columns="2"
            role="group"
            aria-label="媒体参数"
          >
            <CompactSelect
              label="视频清晰度"
              value={normalizeCurrentOptionValue(parameters.resolution)}
              options={mediaOptions.resolution}
              onChange={(value) => updateParameter('resolution', value)}
              className="node-quick-editor-select-group"
              placement="top"
              optionLayout="grid"
              floating
            />
            <QuickOptionMenu
              label="视频比例"
              value={parameters.aspectRatio}
              options={mediaOptions.aspectRatio}
              aspectOptions
              onChange={(value) => updateParameter('aspectRatio', value)}
            />
            <CompactSelect
              label="时长（秒）"
              value={normalizeCurrentOptionValue(parameters.duration)}
              options={mediaOptions.duration}
              onChange={(value) => {
                setDurationDraft(value);
                updateParameter('duration', value ? Number(value) : undefined);
              }}
              className="node-quick-editor-select-group"
              placement="top"
              optionLayout="grid"
              floating
            />
            <label className="compact-select node-quick-editor-select-group">
              <span className="compact-select-label">
                {supportsAutomaticDuration ? '自定义秒数（-1 为自动）' : '自定义秒数'}
              </span>
              <input
                className="compact-select-trigger node-quick-editor-number-input"
                type="number"
                inputMode="numeric"
                min={supportsAutomaticDuration ? -1 : 1}
                max={Number.MAX_SAFE_INTEGER}
                step={1}
                value={durationDraft}
                placeholder="输入秒数"
                aria-invalid={Boolean(durationIssue)}
                disabled={!onParametersChange}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDurationDraft(value);
                  if (value === '') updateParameter('duration', undefined);
                  else if (
                    Number.isSafeInteger(Number(value)) &&
                    (Number(value) > 0 || (supportsAutomaticDuration && Number(value) === -1))
                  ) {
                    updateParameter('duration', Number(value));
                  }
                }}
              />
            </label>
            <CompactSelect
              label="完成后"
              value={resolveVideoCompletionAction(node.data)}
              options={[
                { value: 'none', label: '不提取末帧' },
                { value: 'preview_final_frame', label: '预览末帧' },
                { value: 'create_asset', label: '创建末帧图片' },
                { value: 'append_image_node', label: '追加图片节点' },
                { value: 'fill_designated_image_node', label: '填入指定空节点' },
              ]}
              onChange={(value) =>
                onCompletionActionChange?.((value || 'none') as VideoCompletionAction)
              }
              className="node-quick-editor-select-group"
              placement="top"
              floating
            />
            {resolveVideoCompletionAction(node.data) === 'fill_designated_image_node' ? (
              <CompactSelect
                label="填充目标"
                value={node.data.completionTargetNodeId ?? ''}
                options={[
                  { value: '', label: '未指定' },
                  ...emptyImageNodes.map((item) => ({ value: item.id, label: item.label })),
                ]}
                onChange={(value) => onCompletionTargetNodeIdChange?.(value || undefined)}
                className="node-quick-editor-select-group"
                placement="top"
                floating
              />
            ) : null}
          </div>
        </>
      )}

      {node.data.mediaType === 'audio' && (
        <div
          className="node-quick-editor-media-options"
          data-columns="2"
          role="group"
          aria-label="媒体参数"
        >
          <label className="compact-select node-quick-editor-select-group">
            <span className="compact-select-label">音色</span>
            <input
              className="compact-select-trigger"
              style={{ cursor: 'text' }}
              type="text"
              value={typeof parameters.voice === 'string' ? parameters.voice : ''}
              placeholder="输入音色 ID"
              required
              aria-invalid={typeof parameters.voice !== 'string' || !parameters.voice.trim()}
              title="音色（必填）"
              disabled={!onParametersChange}
              onChange={(event) =>
                updateParameter(
                  'voice',
                  event.currentTarget.value.trim() ? event.currentTarget.value : undefined,
                )
              }
            />
          </label>
          <CompactSelect
            label="音频格式"
            value={normalizeCurrentOptionValue(parameters.response_format)}
            options={getAudioFormatOptions(parameters.response_format, selectedModel)}
            onChange={(value) => updateParameter('response_format', value)}
            disabled={!onParametersChange}
            className="node-quick-editor-select-group"
            placement="top"
            floating
          />
          <label className="compact-select node-quick-editor-select-group">
            <span className="compact-select-label">语速</span>
            <input
              className="compact-select-trigger"
              style={{ cursor: 'text' }}
              type="number"
              inputMode="decimal"
              min={AUDIO_SPEED_RANGE.min}
              max={AUDIO_SPEED_RANGE.max}
              step="any"
              value={
                typeof parameters.speed === 'number' && Number.isFinite(parameters.speed)
                  ? parameters.speed
                  : typeof parameters.speed === 'string'
                    ? parameters.speed
                    : ''
              }
              placeholder="倍率 0.25–4"
              aria-invalid={parameters.speed !== undefined && !isValidAudioSpeed(parameters.speed)}
              title="语速范围：0.25 至 4"
              disabled={!onParametersChange}
              onChange={(event) =>
                updateParameter(
                  'speed',
                  event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber,
                )
              }
            />
          </label>
        </div>
      )}
      {inferenceEditor}
      {mediaParameterIssue && (
        <p className="node-quick-editor-parameter-issue" role="status">
          {mediaParameterIssue}
        </p>
      )}
    </div>
  );

  /** 摘要仅展示已保存值；未设置项不假装已提交模型默认参数。 */
  const summaryItems = getMediaSummary(node.data.mediaType, parameters, mediaOptions);
  const mediaSummary =
    node.data.mediaType === 'text' ? null : (
      <button
        ref={settingsTriggerRef}
        type="button"
        className="node-quick-editor-summary-button"
        onBlur={blurMediaSettings}
        onClick={() => {
          clearTimeout(settingsCloseTimerRef.current);
          if (mediaSettingsOpen && settingsPinnedRef.current) closeMediaSettings();
          else {
            settingsPinnedRef.current = true;
            setMediaSettingsOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (isImeKeyboardEvent(event)) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            closeMediaSettings();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            settingsPinnedRef.current = true;
            enterMediaSettings();
            requestAnimationFrame(() => settingsRef.current?.querySelector('button')?.focus());
          }
        }}
        aria-expanded={mediaSettingsOpen}
        aria-controls={settingsId}
        aria-label="媒体参数"
        title={summaryItems.map((item) => item.label + '：' + item.value).join(' · ')}
      >
        <SlidersHorizontal size={15} aria-hidden="true" />
        <span>{summaryItems.map((item) => item.value).join(' · ')}</span>
      </button>
    );

  const controls = (
    <div
      className="node-quick-editor-controls"
      data-has-inference={
        node.data.mediaType !== 'text' || inferenceOptions.length > 0 ? 'true' : 'false'
      }
    >
      {!expandedEditorOpen && (
        <button
          type="button"
          ref={expandTriggerRef}
          className="node-quick-editor-expand"
          aria-label="打开完整编辑器"
          title="放大编辑器"
          onClick={() => {
            closeMediaSettings();
            setExpandedEditorOpen(true);
          }}
        >
          <Expand size={16} aria-hidden="true" />
        </button>
      )}
      <CompactSelect
        label="模型"
        value={currentModelValue}
        options={modelOptions}
        onChange={(value) => onModelChange(parseModelOptionValue(value))}
        className="node-quick-editor-select-group"
        placement="top"
        floating
      />
      {videoModeEditor}
      {node.data.mediaType === 'text' ? inferenceEditor : mediaSummary}
      {node.data.mediaType !== 'text' && (
        <div
          ref={settingsRef}
          id={settingsId}
          className="node-quick-editor-parameter-popover"
          popover="manual"
          style={settingsStyle}
          hidden={!mediaSettingsOpen}
          role="region"
          aria-label="生成参数"
          onBlur={blurMediaSettings}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !isImeKeyboardEvent(event)) {
              event.preventDefault();
              event.stopPropagation();
              closeMediaSettings();
              settingsTriggerRef.current?.focus();
            }
          }}
        >
          <div className="node-quick-editor-parameter-heading">
            <strong>生成参数</strong>
            <button
              type="button"
              aria-label="收起媒体参数"
              onClick={() => {
                closeMediaSettings();
                settingsTriggerRef.current?.focus();
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {mediaSettingsOpen && mediaParameterEditor}
        </div>
      )}
      <div className="node-quick-editor-run-group">
        <label className="node-quick-editor-generation-count" title="本次生成数量">
          <span>数量</span>
          <input
            type="number"
            inputMode="numeric"
            aria-label="生成数量"
            min={1}
            max={GENERATION_COUNT_MAX}
            step={1}
            value={generationCountDraft}
            aria-invalid={Boolean(generationCountIssue)}
            disabled={busy || !onGenerationCountChange}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setGenerationCountDraft(value);
              if (isValidGenerationCount(Number(value))) {
                onGenerationCountChange?.(Number(value));
              }
            }}
          />
        </label>
        {canRunSameNode(node) ? (
          <button
            type="button"
            className="button button-primary node-quick-editor-run"
            aria-label={busy ? '生成中' : '生成'}
            title={
              busy
                ? '生成中'
                : !enabled
                  ? '节点已停用'
                  : (modelIssue ??
                    generationCountIssue ??
                    mediaParameterIssue ??
                    (!hasRunnableParameters
                      ? imageEditPromptRequired
                        ? '请先填写想用这张图修改什么'
                        : '请先填写提示词或连接输入节点'
                      : '生成'))
            }
            onClick={onRun}
            disabled={
              busy ||
              !enabled ||
              !hasRunnableParameters ||
              Boolean(modelIssue || generationCountIssue || mediaParameterIssue)
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
            <span>{busy ? '生成中' : '生成'}</span>
          </button>
        ) : null}
        {canForkNewNode(node) ? (
          <button
            type="button"
            className="button node-quick-editor-run node-quick-editor-run-new"
            aria-label="新节点"
            title={
              busy
                ? '生成中'
                : !enabled
                  ? '节点已停用'
                  : modelIssue ||
                      generationCountIssue ||
                      durationIssue ||
                      resolutionIssue ||
                      aspectRatioIssue ||
                      videoContractParameterIssue
                    ? (modelIssue ??
                      generationCountIssue ??
                      durationIssue ??
                      resolutionIssue ??
                      aspectRatioIssue ??
                      videoContractParameterIssue)
                    : !nodeHasPrompt(node.data)
                      ? '请先填写提示词'
                      : node.data.mediaType === 'image' &&
                          selectedModel &&
                          imageEditCapability(selectedModel).unsupported
                        ? '当前模型明确不支持图片编辑，请更换模型后再运行'
                        : mediaParameterIssue && node.data.mediaType === 'image'
                          ? mediaParameterIssue
                          : '把修改结果写到新节点'
            }
            onClick={() => onRunNewNode?.()}
            disabled={
              busy ||
              !enabled ||
              !onRunNewNode ||
              Boolean(
                modelIssue ||
                generationCountIssue ||
                durationIssue ||
                resolutionIssue ||
                aspectRatioIssue ||
                videoContractParameterIssue,
              ) ||
              !nodeHasPrompt(node.data) ||
              Boolean(
                node.data.mediaType === 'image' &&
                selectedModel &&
                imageEditCapability(selectedModel).unsupported,
              ) ||
              Boolean(mediaParameterIssue && node.data.mediaType === 'image')
            }
          >
            <GitFork size={16} aria-hidden="true" />
            <span>新节点</span>
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <section
        className="node-quick-editor nodrag nowheel nopan"
        aria-label={
          imageEditSource ? `${node.data.label}图片修改设置` : `${node.data.label}生成设置`
        }
        hidden={expandedEditorOpen}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {!expandedEditorOpen && (
          <>
            <div className="node-quick-editor-prompt-group">
              {imageEditSourcePreview}
              {promptEditor}
              {skillPanel}
              {skillLibraryError ? (
                <p className="node-quick-editor-parameter-issue" role="alert">
                  {skillLibraryError}
                </p>
              ) : null}
            </div>
            {controls}
            {generationCountIssue && (
              <p className="node-quick-editor-parameter-issue" role="status">
                {generationCountIssue}
              </p>
            )}
          </>
        )}
      </section>
      <Dialog open={expandedEditorOpen} onOpenChange={setExpandedEditorOpen}>
        {expandedEditorOpen && (
          <DialogContent
            className="node-quick-editor-dialog"
            overlayClassName="node-quick-editor-dialog-backdrop"
            aria-labelledby={dialogTitleId}
            aria-describedby={undefined}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              document
                .querySelector<HTMLTextAreaElement>('.node-quick-editor-dialog textarea')
                ?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              expandTriggerRef.current?.focus();
            }}
            onEscapeKeyDown={(event) => {
              // Radix 在捕获阶段处理 Escape，先让展开的 Skill 配置消费它。
              if (
                isImeKeyboardEvent(event) ||
                document.querySelector(
                  '.node-quick-editor-dialog .prompt-skill-trigger[aria-expanded="true"]',
                )
              )
                event.preventDefault();
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <div className="node-quick-editor-dialog-header">
              <div>
                <DialogTitle id={dialogTitleId}>{node.data.label} · 编辑设置</DialogTitle>
              </div>
              <DialogClose asChild>
                <button
                  type="button"
                  className="node-quick-editor-dialog-close"
                  aria-label="关闭编辑器"
                  title="关闭"
                >
                  <X size={17} aria-hidden="true" />
                </button>
              </DialogClose>
            </div>
            <div className="node-quick-editor-dialog-body">
              <div className="node-quick-editor-prompt-group">
                {promptEditor}
                {skillPanel}
                {skillLibraryError ? (
                  <p className="node-quick-editor-parameter-issue" role="alert">
                    {skillLibraryError}
                  </p>
                ) : null}
              </div>
              {controls}
              {generationCountIssue && (
                <p className="node-quick-editor-parameter-issue" role="status">
                  {generationCountIssue}
                </p>
              )}
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** 返回两到三个当前参数标签，仅用于显示，不修改未设置项。 */
function getMediaSummary(
  mediaType: AssetFlowNode['data']['mediaType'],
  parameters: NodeMediaParameters,
  options: ReturnType<typeof getMediaOptions>,
) {
  const getOptionLabel = (value: unknown, choices: MediaOption[], fallback: string) => {
    const normalized = normalizeCurrentOptionValue(value);
    return (choices.find((option) => option.value === normalized)?.label ?? normalized) || fallback;
  };
  if (mediaType === 'image') {
    return [
      { label: '清晰度', value: getOptionLabel(parameters.quality, options.quality, '未设置') },
      { label: '比例', value: normalizeCurrentOptionValue(parameters.aspectRatio) || '未设置' },
    ];
  }
  if (mediaType === 'video') {
    return [
      {
        label: '清晰度',
        value: getOptionLabel(parameters.resolution, options.resolution, '未设置'),
      },
      {
        label: '比例',
        value: getOptionLabel(parameters.aspectRatio, options.aspectRatio, '未设置'),
      },
      {
        label: '时长',
        value:
          parameters.duration === -1
            ? getOptionLabel(parameters.duration, options.duration, '自动')
            : parameters.duration
              ? `${parameters.duration}s`
              : '未设置',
      },
    ];
  }
  return [
    { label: '音色', value: normalizeCurrentOptionValue(parameters.voice) || '未设置' },
    {
      label: '格式',
      value: normalizeCurrentOptionValue(parameters.response_format)?.toUpperCase() || '未设置',
    },
    { label: '语速', value: parameters.speed ? `${parameters.speed}x` : '未设置' },
  ];
}
/** 从节点数据中读取媒体参数，并返回可独立修改的浅拷贝。 */
function readNodeMediaParameters(data: unknown): NodeMediaParameters {
  if (!data || typeof data !== 'object') return {};
  const candidate = (data as { parameters?: unknown }).parameters;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return { ...(candidate as Record<string, unknown>) };
}

/** 检查已保存的语速；字符串、非有限值和越界值不能作为合法倍率提交。 */
function isValidAudioSpeed(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= AUDIO_SPEED_RANGE.min &&
    value <= AUDIO_SPEED_RANGE.max
  );
}

/**
 * 音频生成的前置校验；返回首个需要修正的字段提示，合法时返回 undefined。
 * 只检查契约，不修改节点或猜测默认值；后端仍负责最终校验。
 */
function getAudioParameterIssue(
  parameters: NodeMediaParameters,
  model?: ModelEntry,
): string | undefined {
  if (typeof parameters.voice !== 'string' || !parameters.voice.trim()) return '请先填写音色';
  if (
    parameters.response_format !== undefined &&
    !getSupportedAudioFormatOptions(model).some(
      (option) => option.value && option.value === parameters.response_format,
    )
  ) {
    return '请选择支持的音频格式';
  }
  if (parameters.speed !== undefined && !isValidAudioSpeed(parameters.speed)) {
    return '语速必须为 0.25 至 4 的有限数值';
  }
  return undefined;
}

/** 保留不支持的历史格式供用户发现并修正，不将它替换成菜单首项或静默删除。 */
function getAudioFormatOptions(value: unknown, model?: ModelEntry): MediaOption[] {
  const current = normalizeCurrentOptionValue(value);
  const options = getSupportedAudioFormatOptions(model);
  if (!current || options.some((option) => option.value === current)) {
    return options;
  }
  return [
    ...options,
    { value: current, label: current, description: '已保存，当前不支持', disabled: true },
  ];
}

/** 优先使用模型声明且 Provider 已支持的音频格式；空枚举表示不支持，不回退。 */
function getSupportedAudioFormatOptions(model?: ModelEntry): MediaOption[] {
  const declared = readCapabilityOptions(
    getCapabilityRoots(model, 'audio'),
    [
      'response_format',
      'response_formats',
      'responseFormat',
      'responseFormats',
      'formats',
      'audioFormats',
      'audio_formats',
    ],
    'resolution',
  );
  if (declared === undefined) return AUDIO_FORMAT_OPTIONS;
  return [
    AUDIO_FORMAT_OPTIONS[0],
    ...declared
      .filter((option) =>
        AUDIO_FORMAT_OPTIONS.some((supported) => supported.value === option.value),
      )
      .map((option) => ({ ...option, label: option.value.toUpperCase() })),
  ];
}

/** 渲染一个统一的向上展开选择菜单。 */
function QuickOptionMenu({
  label,
  value,
  options,
  onChange,
  aspectOptions = false,
}: {
  label: string;
  value?: unknown;
  options: QuickOption[];
  onChange: (value: string) => void;
  aspectOptions?: boolean;
}) {
  const stringValue = normalizeCurrentOptionValue(value);
  const hasExplicitSelection = Boolean(
    stringValue && options.some((option) => option.value === stringValue),
  );
  const selectedValue = options.some((option) => option.value === stringValue)
    ? stringValue
    : (options[0]?.value ?? '');
  const selectedOption = options.find((option) => option.value === selectedValue) ??
    options[0] ?? {
      value: '',
      label: '暂无选项',
    };
  const [open, setOpen] = useState(false);
  /** 保持原有按钮语义，并将比例菜单放入浏览器顶层以避免滚动裁切。 */
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openedByHoverRef = useRef(false);
  /** 比例菜单同样允许跨越浮层间隙，点击与键盘打开后不随鼠标离开收起。 */
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);
  useEffect(() => {
    if (!open) return;
    /** 焦点仍在提示词时，优先关闭当前比例菜单。 */
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeKeyboardEvent(event)) return;
      event.preventDefault();
      openedByHoverRef.current = false;
      clearTimeout(closeTimerRef.current);
      setOpen(false);
    };
    document.addEventListener('keydown', dismissOnEscape);
    return () => document.removeEventListener('keydown', dismissOnEscape);
  }, [open]);
  const menuStyle = useFloatingParameterMenu({
    anchorRef: rootRef,
    menuRef,
    enabled: true,
    open,
    placement: 'top',
  });
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  let previousGroup: string | undefined;

  return (
    <div
      ref={rootRef}
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      data-placement="top"
      onBlur={handleBlur}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !isImeKeyboardEvent(event)) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="node-quick-editor-option-trigger"
        aria-label={`${label}：${formatTriggerLabel(selectedOption, hasExplicitSelection, options)}`}
        aria-expanded={open}
        disabled={!options.some((option) => !option.disabled)}
        onClick={() => {
          clearTimeout(closeTimerRef.current);
          openedByHoverRef.current = false;
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          openedByHoverRef.current = false;
          clearTimeout(closeTimerRef.current);
          setOpen(true);
          requestAnimationFrame(() => {
            const choices =
              menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            const index = event.key === 'ArrowUp' ? (choices?.length ?? 1) - 1 : 0;
            choices?.[index]?.focus();
          });
        }}
      >
        <span title={formatTriggerLabel(selectedOption, hasExplicitSelection, options)}>
          {formatTriggerLabel(selectedOption, hasExplicitSelection, options)}
        </span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div
        ref={menuRef}
        className="node-quick-editor-option-popover"
        role="group"
        aria-label={`${label}选项`}
        hidden={!open}
        popover="manual"
        style={menuStyle}
      >
        {options.map((option) => {
          const showGroup = option.groupLabel && option.groupLabel !== previousGroup;
          previousGroup = option.groupLabel;
          return (
            <span key={`${option.groupLabel ?? ''}:${option.value}`}>
              {showGroup && (
                <span className="node-quick-editor-option-group-label">{option.groupLabel}</span>
              )}
              <button
                type="button"
                className={`node-quick-editor-option ${
                  aspectOptions ? 'node-quick-editor-aspect-option' : ''
                } ${selectedValue === option.value ? 'is-active' : ''}`}
                aria-pressed={selectedValue === option.value}
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                title={formatOptionLabel(option)}
              >
                {aspectOptions && option.previewAspectRatio && (
                  <span
                    className="node-quick-editor-aspect-preview"
                    style={{ aspectRatio: option.previewAspectRatio }}
                    aria-hidden="true"
                  />
                )}
                <span className="node-quick-editor-option-copy">
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 为新建节点或显式切换模型补齐媒体枚举的第一项；推理强度优先 high、标签“高”、首项。
 * 返回可直接写入节点的浅拷贝，不修改输入；已有参数和未知字段全部保留。
 * 只使用该媒体模型声明的枚举或已确认的 TTS/GPT 契约；没有模型或没有枚举时不造值，
 * 切换到不支持自动时长或比例的模型时移除 -1/adaptive，再按新目录补默认值。
 * 音色和连续语速由用户填写，像素宽高仅保留旧值。不得在渲染或加载历史节点时自动调用。
 */
export function applyNodeGenerationDefaults(
  data: AssetFlowNode['data'],
  model: ModelEntry | undefined,
): AssetFlowNode['data'] {
  const mediaType = data.mediaType;
  const parameters = readNodeMediaParameters(data);
  if (mediaType === 'video') {
    const family = videoFamilyForModel(model?.id ?? data.modelAlias);
    if (!supportsAutomaticVideoDuration(family) && parameters.duration === -1) {
      delete parameters.duration;
    }
    if (!supportsAdaptiveVideoAspectRatio(family) && parameters.aspectRatio === 'adaptive') {
      delete parameters.aspectRatio;
    }
  }
  if (!model?.mediaTypes.includes(mediaType)) return { ...data, parameters };
  const options = getMediaOptions(model, mediaType, {}, false, data.modelAlias);
  const fields =
    mediaType === 'image'
      ? (['quality', 'aspectRatio'] as const)
      : mediaType === 'video'
        ? (['resolution', 'aspectRatio', 'duration'] as const)
        : [];
  for (const field of fields) {
    if (parameters[field] !== undefined) continue;
    const choices =
      field === 'duration'
        ? options[field].filter((option) => {
            const seconds = Number(option.value);
            return Number.isInteger(seconds) && seconds > 0;
          })
        : options[field];
    const value = firstAvailableOption(choices);
    if (value === undefined) continue;
    if (field === 'duration') parameters.duration = Number(value);
    else parameters[field] = value;
  }
  if (mediaType === 'audio' && parameters.response_format === undefined) {
    const format = firstAvailableOption(getSupportedAudioFormatOptions(model));
    if (format !== undefined) parameters.response_format = format;
  }
  const inferenceStrength =
    data.inferenceStrength ??
    preferredInferenceStrength(getInferenceStrengthOptions(model, mediaType, model.id, undefined));
  return { ...data, parameters, ...(inferenceStrength === undefined ? {} : { inferenceStrength }) };
}

/** 只从可用档位选择 high，其次中文标签“高”，最后目录首项；空目录不造值。 */
function preferredInferenceStrength(options: readonly MediaOption[]): string | undefined {
  const available = options.filter((option) => !option.disabled && option.value.trim());
  return (
    available.find((option) => option.value === 'high') ??
    available.find((option) => option.label.trim() === '高') ??
    available[0]
  )?.value;
}

/** 排除空占位和禁用项后返回第一项；没有选项时返回 undefined。 */
function firstAvailableOption(options: readonly MediaOption[]): string | undefined {
  return options.find((option) => !option.disabled && option.value.trim())?.value;
}

/**
 * 从画布已有同类型操作节点取出最近一次的模型与参数，供新建节点沿用。
 * @param nodes 当前画布节点，后创建的节点优先。
 * @param mediaType 新建节点的媒体类型。
 * @param mode 新建节点的操作模式。
 * @returns 最近同类型节点的模型、凭据、参数和推理强度；没有可沿用节点时返回 undefined。
 */
export function resolvePreviousOperationSeed(
  nodes: readonly AssetFlowNode[],
  mediaType: AssetFlowNode['data']['mediaType'],
  mode: Exclude<AssetFlowNode['data']['mode'], 'source'>,
):
  | Pick<
      AssetFlowNode['data'],
      'modelAlias' | 'credentialId' | 'platformModelId' | 'parameters' | 'inferenceStrength'
    >
  | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const data = nodes[index]?.data;
    if (!data || data.mediaType !== mediaType || data.mode !== mode) continue;
    const parameters = readNodeMediaParameters(data);
    return {
      ...(data.modelAlias ? { modelAlias: data.modelAlias } : {}),
      ...(data.platformModelId ? { platformModelId: data.platformModelId } : {}),
      ...(data.credentialId ? { credentialId: data.credentialId } : {}),
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      ...(data.inferenceStrength ? { inferenceStrength: data.inferenceStrength } : {}),
    };
  }
  return undefined;
}

/** 返回当前模型的媒体能力；官方视频合同可补目录缺项，通用旧回退只供手动选择。 */
function getMediaOptions(
  model: ModelEntry | undefined,
  mediaType: AssetFlowNode['data']['mediaType'],
  parameters: NodeMediaParameters,
  allowLegacyFallback = true,
  modelAlias?: string,
  allowMoonH3SuperResolution = false,
) {
  const roots = getCapabilityRoots(model, mediaType);
  const family = videoFamilyForModel(modelAlias ?? model?.id);
  const resolutionContract =
    mediaType === 'video'
      ? videoResolutionContractForModel(modelAlias ?? model?.id, allowMoonH3SuperResolution)
      : undefined;
  const durationContract = mediaType === 'video' ? videoDurationContracts[family] : undefined;
  const quality = ensureCurrentOption(
    readCapabilityOptions(
      roots,
      ['quality', 'qualities', 'imageQuality', 'image_quality', 'resolution', 'resolutions'],
      'quality',
    ) ?? (allowLegacyFallback ? imageQualityOptions : []),
    parameters.quality,
    'quality',
  );
  const declaredResolution = readCapabilityOptions(
    roots,
    ['resolution', 'resolutions', 'videoResolution', 'video_resolution', 'quality', 'qualities'],
    'resolution',
  );
  const contractResolutionOptions = resolutionContract?.map((value) => ({
    ...(declaredResolution?.find((option) => option.value.toLowerCase() === value) ?? {}),
    value,
    label:
      declaredResolution?.find((option) => option.value.toLowerCase() === value)?.label ??
      value.toUpperCase(),
  }));
  const resolution = ensureCurrentOption(
    contractResolutionOptions ??
      declaredResolution ??
      (allowLegacyFallback ? videoResolutionOptions : []),
    parameters.resolution,
    'resolution',
  ).map((option) =>
    resolutionContract && !resolutionContract.includes(option.value.toLowerCase())
      ? { ...option, disabled: true, description: '已保存，当前模型不支持' }
      : option,
  );
  const ratioContract: readonly string[] | undefined =
    mediaType !== 'video'
      ? undefined
      : family === 'moon-minimax-h3'
        ? moonH3FixedAspectRatios
        : family === 'minimax-h3' || supportsAdaptiveVideoAspectRatio(family)
          ? [
              'adaptive',
              '1:1',
              '16:9',
              '9:16',
              '4:3',
              '3:4',
              ...(family === 'wan3' ? [] : ['21:9']),
            ]
          : undefined;
  const declaredAspectRatios =
    readCapabilityOptions(
      roots,
      ['aspectRatio', 'aspectRatios', 'aspect_ratio', 'aspect_ratios', 'ratios'],
      'aspectRatio',
    ) ?? (allowLegacyFallback ? aspectRatioOptions : []);
  const supportedAspectRatios =
    family === 'moon-minimax-h3'
      ? moonH3FixedAspectRatios.map(
          (value) =>
            declaredAspectRatios.find((option) => option.value === value) ??
            aspectRatioOptions.find((option) => option.value === value) ?? { value, label: value },
        )
      : declaredAspectRatios.filter(
          (option) => !ratioContract || ratioContract.includes(option.value),
        );
  const aspectRatio = ensureCurrentOption(
    supportedAspectRatios,
    parameters.aspectRatio,
    'aspectRatio',
  ).map((option) =>
    ratioContract && !ratioContract.includes(option.value)
      ? { ...option, disabled: true, description: '已保存，当前模型不支持' }
      : option,
  );
  const declaredDuration = readCapabilityOptions(
    roots,
    ['duration', 'durations', 'seconds', 'durationSeconds', 'duration_seconds'],
    'duration',
  );
  const supportedDeclaredDuration = durationContract
    ? (declaredDuration ?? []).filter((option) => {
        const seconds = Number(option.value);
        return (
          Number.isSafeInteger(seconds) &&
          ((supportsAutomaticVideoDuration(family) && seconds === -1) ||
            (seconds >= durationContract.min && seconds <= durationContract.max))
        );
      })
    : declaredDuration;
  const fallbackDurations =
    durationContract?.presets ?? (allowLegacyFallback ? [4, 8, 12, 15, 20] : []);
  const durationOptions = durationContract
    ? [
        ...(supportedDeclaredDuration ?? []),
        ...fallbackDurations
          .filter(
            (value) => !supportedDeclaredDuration?.some((option) => option.value === String(value)),
          )
          .map((value) => ({
            value: String(value),
            label: String(value),
            description: '秒',
          })),
      ]
    : (supportedDeclaredDuration ??
      fallbackDurations.map((value) => ({
        value: String(value),
        label: String(value),
        description: '秒',
      })));
  const duration = ensureCurrentOption(durationOptions, parameters.duration, 'duration').map(
    (option) => {
      if (!durationContract) return option;
      const seconds = Number(option.value);
      const supported =
        Number.isSafeInteger(seconds) &&
        ((supportsAutomaticVideoDuration(family) && seconds === -1) ||
          (seconds >= durationContract.min && seconds <= durationContract.max));
      return supported
        ? option
        : { ...option, disabled: true, description: '已保存，当前模型不支持' };
    },
  );
  return { quality, resolution, aspectRatio, duration };
}

/**
 * 从当前模型能力中读取推理强度的原始标识。
 *
 * 模型目录没有统一字段名：有的使用 `reasoning_effort`，有的使用
 * `thinking.levels` 或 `supported_reasoning_efforts`。这里按常见别名和
 * 嵌套结构读取；找不到声明时，对 GPT-5.6 系列和尚未绑定模型的文字
 * 节点显示截图约定的六档菜单，其它模型只保留节点中已经保存的当前值。
 */
function getInferenceStrengthOptions(
  model: ModelEntry | undefined,
  mediaType: AssetFlowNode['data']['mediaType'],
  modelAlias: string,
  currentValue: unknown,
): QuickOption[] {
  const roots = getCapabilityRoots(model, mediaType);
  const normalizedModelAlias = (modelAlias.trim() || model?.id || '').toLowerCase();
  const supportsGpt56Fallback =
    mediaType === 'text' && (!normalizedModelAlias || isGpt56TextModelAlias(normalizedModelAlias));
  const aliases = [
    'inferenceStrength',
    'inferenceStrengths',
    'inference_strength',
    'inference_strengths',
    'reasoningEffort',
    'reasoningEffortOptions',
    'reasoningEfforts',
    'reasoning_effort',
    'reasoning_effort_options',
    'reasoning_efforts',
    'supportedReasoningEfforts',
    'supported_reasoning_efforts',
    'reasoningLevels',
    'reasoning_levels',
    'thinkingLevels',
    'thinking_levels',
    'reasoning',
    'thinking',
    'inference',
    'effortLevels',
    'effort_levels',
    'effort',
    'efforts',
  ];
  const declared = readCapabilityOptions(roots, aliases, 'inferenceStrength');
  if (declared?.length === 0) return ensureCurrentOption([], currentValue, 'inferenceStrength');
  if (declared && declared.length > 0) {
    if (
      supportsGpt56Fallback &&
      (isLowOnlyInferenceOptions(declared) || isLegacyGpt56InferenceOptions(declared))
    ) {
      return ensureCurrentOption(
        GPT_56_REASONING_EFFORTS.map((value) => createInferenceOption(value)),
        currentValue,
        'inferenceStrength',
      );
    }
    return ensureCurrentOption(
      localizeInferenceOptions(declared),
      currentValue,
      'inferenceStrength',
    );
  }
  const nested = readNestedInferenceOptions(roots);
  if (nested.length > 0) {
    if (
      supportsGpt56Fallback &&
      (isLowOnlyInferenceOptions(nested) || isLegacyGpt56InferenceOptions(nested))
    ) {
      return ensureCurrentOption(
        GPT_56_REASONING_EFFORTS.map((value) => createInferenceOption(value)),
        currentValue,
        'inferenceStrength',
      );
    }
    return ensureCurrentOption(localizeInferenceOptions(nested), currentValue, 'inferenceStrength');
  }

  if (supportsGpt56Fallback) {
    return ensureCurrentOption(
      GPT_56_REASONING_EFFORTS.map((value) => createInferenceOption(value)),
      currentValue,
      'inferenceStrength',
    );
  }

  const current = normalizeCurrentOptionValue(currentValue);
  if (current) {
    return [
      {
        value: current,
        label: INFERENCE_STRENGTH_LABELS[current.toLowerCase()] ?? current,
        description: '已保存',
      },
    ];
  }

  return [];
}

/** 判断模型目录是否只返回 low 占位值。 */
function isLowOnlyInferenceOptions(options: MediaOption[]): boolean {
  return (
    options.length > 0 && options.every((option) => option.value.trim().toLowerCase() === 'low')
  );
}

/** 判断模型别名是否属于已确认支持六档推理强度的 GPT-5.6 系列。 */
function isGpt56TextModelAlias(modelAlias: string): boolean {
  return GPT_56_TEXT_MODEL_ALIAS_PATTERN.test(modelAlias.trim().toLowerCase());
}

/** 判断模型目录是否仍返回上一版包含 none 的 GPT-5.6 回退档位。 */
function isLegacyGpt56InferenceOptions(options: MediaOption[]): boolean {
  return (
    options.length === LEGACY_GPT_56_REASONING_EFFORTS.length &&
    options.every(
      (option, index) =>
        option.value.trim().toLowerCase() === LEGACY_GPT_56_REASONING_EFFORTS[index],
    )
  );
}

/** 将已知推理值转换为截图约定的中文标签，未知值保留模型目录原文。 */
function localizeInferenceOptions(options: MediaOption[]): MediaOption[] {
  return options.map((option) => ({
    ...option,
    label: INFERENCE_STRENGTH_LABELS[option.value.trim().toLowerCase()] ?? option.label,
  }));
}

/** 创建带有固定 UI 标签的 GPT 推理强度选项。 */
function createInferenceOption(value: string): MediaOption {
  return {
    value,
    label: INFERENCE_STRENGTH_LABELS[value] ?? value,
  };
}

/** 在 `reasoning`/`thinking` 等包装对象中查找强度列表。 */
function readNestedInferenceOptions(roots: Record<string, unknown>[]): MediaOption[] {
  const options: MediaOption[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, hint: string, depth: number) => {
    if (depth > 4 || value === null || value === undefined) return;
    const hintMatches = /(reason|think|effort|inference)/i.test(hint);
    if (hintMatches) {
      const direct = normalizeRawOptions(value, 'inferenceStrength');
      for (const option of direct) {
        if (seen.has(option.value)) continue;
        seen.add(option.value);
        options.push(option);
      }
      if (isRecord(value)) {
        const keyOptions = normalizeInferenceMap(value);
        for (const option of keyOptions) {
          if (seen.has(option.value)) continue;
          seen.add(option.value);
          options.push(option);
        }
      }
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, hint, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const childHint = hintMatches ? `${hint}.${key}` : key;
      visit(child, childHint, depth + 1);
    }
  };
  roots.forEach((root) => visit(root, '', 0));
  return options;
}

/** 兼容 `{ low: true, high: true }` 一类的能力映射。 */
function normalizeInferenceMap(value: Record<string, unknown>): MediaOption[] {
  const metadataKeys = new Set([
    'enabled',
    'supported',
    'available',
    'default',
    'description',
    'type',
    'enum',
    'values',
    'options',
    'items',
    'levels',
    'efforts',
    'reasoning',
    'thinking',
  ]);
  const entries = Object.entries(value).filter(([key, child]) => {
    if (metadataKeys.has(key.toLowerCase())) return false;
    if (child === true) return true;
    if (!isRecord(child)) return false;
    return !['enabled', 'supported', 'available'].some((flag) => child[flag] === false);
  });
  if (entries.length === 0) return [];
  return entries.map(([key, child]) => ({
    value: key,
    label: isRecord(child) && typeof child.label === 'string' ? child.label : key,
    ...(isRecord(child) && typeof child.description === 'string'
      ? { description: child.description }
      : {}),
  }));
}

/** 构造按媒体类型和凭据筛选后的模型选项。 */
function buildModelOptions(
  models: ModelEntry[],
  currentValue: string,
  currentModel: string,
  currentCredentialId: string | undefined,
  currentModelIsMissing: boolean,
): QuickOption[] {
  const options: QuickOption[] = [];
  if (currentModelIsMissing && currentValue) {
    options.push({
      value: currentValue,
      label: currentModel,
      description: currentCredentialId ? '当前设置，目录中不可用' : '旧设置，未绑定 API Key',
    });
  }
  for (const group of groupModelsByCredential(models)) {
    for (const model of group.models) {
      options.push({
        value: modelOptionValue({
          modelAlias: model.id,
          credentialId: model.credentialId,
          platformModelId: model.platformModelId,
        }),
        label: model.name,
        ...(model.availability && model.availability !== 'available'
          ? {
              disabled: true,
              description: model.availability === 'needs_review' ? '待管理员确认' : '暂不可用',
            }
          : {}),
        groupLabel: group.label,
      });
    }
  }
  return options.length > 0 ? options : [{ value: '', label: '暂无可用模型', disabled: true }];
}

/** 找到节点当前绑定的模型；无绑定时使用当前媒体的第一个模型能力。 */
function findSelectedModel(
  models: ModelEntry[],
  modelAlias: string,
  credentialId: string | undefined,
  platformModelId?: string,
): ModelEntry | undefined {
  return (
    models.find((model) =>
      platformModelId
        ? model.platformModelId === platformModelId
        : !model.platformModelId && model.id === modelAlias && model.credentialId === credentialId,
    ) ?? (!modelAlias ? models[0] : undefined)
  );
}

/** 规范化能力对象的嵌套来源，优先使用媒体专用能力再使用顶层兼容字段。 */
function getCapabilityRoots(
  model: ModelEntry | undefined,
  mediaType: AssetFlowNode['data']['mediaType'],
): Record<string, unknown>[] {
  if (!model) return [];
  const roots: Record<string, unknown>[] = [];
  for (const source of [model.capabilities, model.limitations]) {
    if (!isRecord(source)) continue;
    const parameters = isRecord(source.parameters) ? source.parameters : undefined;
    const mediaParameters =
      parameters && isRecord(parameters[mediaType]) ? parameters[mediaType] : undefined;
    const mediaSource = isRecord(source[mediaType]) ? source[mediaType] : undefined;
    const namedSource = (
      isRecord(source[`${mediaType}Parameters`])
        ? source[`${mediaType}Parameters`]
        : isRecord(source[`${mediaType}_parameters`])
          ? source[`${mediaType}_parameters`]
          : undefined
    ) as Record<string, unknown> | undefined;
    const candidates: Array<Record<string, unknown> | undefined> = [
      mediaSource,
      mediaParameters,
      namedSource,
      parameters,
      source,
    ];
    for (const candidate of candidates) {
      if (candidate && !roots.includes(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

/** 从能力对象读取数组、包装对象或分隔字符串形式的选项。 */
function readCapabilityOptions(
  roots: Record<string, unknown>[],
  aliases: string[],
  kind: 'quality' | 'resolution' | 'aspectRatio' | 'duration' | 'inferenceStrength',
): MediaOption[] | undefined {
  for (const root of roots) {
    for (const alias of aliases) {
      if (root[alias] === undefined || root[alias] === null) continue;
      const options = normalizeRawOptions(root[alias], kind);
      if (options.length > 0 || isExplicitOptionDeclaration(root[alias])) return options;
    }
  }
  return undefined;
}

/** 空数组、禁用标记和显式枚举对象也属于目录声明，不能被旧回退列表覆盖。 */
function isExplicitOptionDeclaration(raw: unknown): boolean {
  return (
    Array.isArray(raw) ||
    raw === false ||
    (isRecord(raw) &&
      (raw.disabled === true ||
        ['enabled', 'supported', 'available'].some((flag) => raw[flag] === false) ||
        ['values', 'options', 'items', 'enum', 'allowed', 'supported'].some(
          (key) => raw[key] !== undefined,
        )))
  );
}

/** 将能力字段转换为稳定、去重且保留上游顺序的按钮选项。 */
function normalizeRawOptions(
  raw: unknown,
  kind: 'quality' | 'resolution' | 'aspectRatio' | 'duration' | 'inferenceStrength',
): MediaOption[] {
  const values = collectRawOptions(raw);
  const seen = new Set<string>();
  const options: MediaOption[] = [];
  for (const item of values) {
    const value = item.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    if (value === '默认值') continue;
    const fallbackDescription = kind === 'aspectRatio' ? aspectRatioDescriptions[value] : undefined;
    const rawDescription = item.description === '默认值' ? undefined : item.description;
    const description =
      rawDescription ?? fallbackDescription ?? (kind === 'duration' ? '秒' : undefined);
    const label =
      item.label && item.label !== '默认值'
        ? item.label
        : kind === 'quality'
          ? value.toUpperCase()
          : value;
    options.push({
      value,
      label,
      ...(description ? { description } : {}),
      ...(kind === 'aspectRatio' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)
        ? { previewAspectRatio: value.replace(':', ' / ') }
        : {}),
    });
  }
  return options;
}

type RawOption = { value: string; label?: string; description?: string };

/** 支持供应商常见的 values/options/items、{value,label}、映射和分隔字符串格式。 */
function collectRawOptions(raw: unknown): RawOption[] {
  if (Array.isArray(raw)) return raw.flatMap((item) => collectRawOptions(item));
  if (typeof raw === 'string' || typeof raw === 'number') {
    return String(raw)
      .split(/[,;|\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ value }));
  }
  if (!isRecord(raw)) return [];
  if (
    raw.disabled === true ||
    ['enabled', 'supported', 'available'].some((flag) => raw[flag] === false)
  )
    return [];
  if (typeof raw.value === 'string' || typeof raw.value === 'number') {
    return [
      {
        value: String(raw.value),
        ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      },
    ];
  }
  for (const key of ['values', 'options', 'items', 'enum', 'allowed', 'supported']) {
    if (raw[key] !== undefined) return collectRawOptions(raw[key]);
  }
  return Object.entries(raw).flatMap(([key, value]) => {
    if (
      [
        'type',
        'default',
        'label',
        'title',
        'description',
        'min',
        'max',
        'minimum',
        'maximum',
        'step',
        'nullable',
        'required',
        'enabled',
        'supported',
        'available',
        'disabled',
      ].includes(key)
    )
      return [];
    if (
      isRecord(value) &&
      (value.disabled === true ||
        ['enabled', 'supported', 'available'].some((flag) => value[flag] === false))
    )
      return [];
    if (value === true) return [{ value: key }];
    if (typeof value === 'string' || typeof value === 'number') {
      return [{ value: key, label: String(value) }];
    }
    if (
      isRecord(value) &&
      (typeof value.label === 'string' ||
        typeof value.description === 'string' ||
        ['enabled', 'supported', 'available'].some((flag) => value[flag] === true))
    ) {
      return [
        {
          value: key,
          label: String(value.label ?? key),
          ...(typeof value.description === 'string' ? { description: value.description } : {}),
        },
      ];
    }
    return [];
  });
}

/** 把旧节点已经保存但当前模型未声明的值追加到菜单，避免数据被静默隐藏。 */
function ensureCurrentOption(
  options: MediaOption[],
  currentValue: unknown,
  kind: 'quality' | 'resolution' | 'aspectRatio' | 'duration' | 'inferenceStrength',
): MediaOption[] {
  const value = normalizeCurrentOptionValue(currentValue);
  if (!value || options.some((option) => option.value === value)) return options;
  return [
    ...options,
    {
      value,
      label:
        kind === 'quality'
          ? value.toUpperCase()
          : kind === 'inferenceStrength'
            ? (INFERENCE_STRENGTH_LABELS[value.toLowerCase()] ?? value)
            : value,
      description: '已保存',
      ...(kind === 'aspectRatio' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)
        ? { previewAspectRatio: value.replace(':', ' / ') }
        : {}),
    },
  ];
}

/** 将节点中的旧参数安全地转换为菜单可比较的非空字符串。 */
function normalizeCurrentOptionValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatOptionLabel(option: MediaOption): string {
  return option.description ? `${option.label} · ${option.description}` : option.label;
}

/**
 * 生成触发器文案：未显式设置时不把模型/参数的首项伪装成用户已选择的值。
 * 首项仍会在浮层中作为当前候选高亮，只有用户确认后才写入节点数据。
 */
function formatTriggerLabel(
  selectedOption: MediaOption,
  hasExplicitSelection: boolean,
  options: MediaOption[],
): string {
  if (hasExplicitSelection || options.length === 0 || !options[0]?.value) {
    return formatOptionLabel(selectedOption);
  }
  return '未设置';
}

/** 将模型与凭据绑定编码为菜单可用的稳定值。 */
function modelOptionValue(selection: ModelSelection) {
  if (!selection.modelAlias) return '';
  if (selection.platformModelId)
    return JSON.stringify(['platform', selection.platformModelId, selection.modelAlias]);
  return JSON.stringify([selection.credentialId ?? '', selection.modelAlias]);
}

/** 解析模型菜单值，并兼容旧版仅含模型别名的值。 */
function parseModelOptionValue(value: string): ModelSelection {
  if (!value) return { modelAlias: '' };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === 'platform' &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string'
    )
      return { platformModelId: parsed[1], modelAlias: parsed[2] };
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[1]
    ) {
      return {
        modelAlias: parsed[1],
        ...(parsed[0] ? { credentialId: parsed[0] } : {}),
      };
    }
  } catch {
    // 兼容旧版只保存模型别名的节点。
  }
  return { modelAlias: value };
}

/** 按凭据分组模型，供模型菜单显示来源分组。 */
function groupModelsByCredential(models: ModelEntry[]) {
  const groups = new Map<string, { id: string; label: string; models: ModelEntry[] }>();
  for (const model of models) {
    const id = model.platformModelId ? 'platform' : (model.credentialId ?? 'active');
    const group = groups.get(id) ?? {
      id,
      label:
        (model.platformModelId ? '平台模型' : model.credentialLabel) ??
        (model.credentialId ? `API Key · ${model.credentialId.slice(0, 8)}` : '当前 API Key'),
      models: [],
    };
    group.models.push(model);
    groups.set(id, group);
  }
  return [...groups.values()];
}

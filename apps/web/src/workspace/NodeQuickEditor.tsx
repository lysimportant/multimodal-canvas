import type { ProjectResourceSearch } from '../project-resource-search';
import {
  ChevronDown,
  Expand,
  EyeOff,
  GitFork,
  ImageOff,
  LoaderCircle,
  Play,
  SlidersHorizontal,
  Square,
  X,
} from 'lucide-react';
import { Checkbox, Popover, Select, type SelectProps } from 'antd';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';

import type {
  Asset,
  ImageOutputParameters,
  PortRole,
  PromptDocument,
  PromptSkill,
  VideoCompletionAction,
  VideoMode,
  VideoRecreationConfig,
} from '@multimodal-canvas/domain';
import {
  DEFAULT_GENERATION_COUNT,
  GENERATION_COUNT_MAX,
  displayVideoMode,
  ImageOutputParameterError,
  normalizeImageOutputParameters,
  resolveImageOutputParameters,
  isValidGenerationCount,
  resolveVideoCompletionAction,
  videoModeDescriptions,
  videoModeLabels,
  videoModes,
} from '@multimodal-canvas/domain';
import { renderPromptDocument } from '@multimodal-canvas/domain';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
} from '@multimodal-canvas/ui';
import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { VideoRecreationPanel } from './VideoRecreationPanel';
import { recreationGenerationIssue } from './video-recreation-node';
import { AssetPreview } from './AssetPreview';
import type { ConnectedPromptAsset } from './connected-prompt-assets';
import { canForkNewNode, canRunSameNode, nodeHasPrompt } from './fork-generate-node';
import { type NodeRunControlStore, useNodeRunControl } from './node-run-control';
import {
  imageEditSourcePreviewAsset,
  type ImageEditSourcePreview,
} from './image-edit-source-preview';
import { useWorkspacePreferences } from '../state/workspace-preferences';
import { PromptSkillPanel, type PromptSkillPanelProps } from './PromptSkillPanel';
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
  /** Images 接口官方尺寸；新编辑只写 WIDTHxHEIGHT 或 auto。 */
  size?: string;
  /** 供应商原生质量；历史 K 档仅兼容读取，显式编辑后并入 size。 */
  quality?: string;
  /** 图片仅兼容旧 K 档或像素别名；视频继续使用各自合同中的清晰度标识。 */
  resolution?: string;
  aspectRatio?: string;
  duration?: number;
  /** 保留历史视频宽度，单位像素；界面不再编辑，新建不初始化。 */
  width?: number;
  /** 保留历史视频高度，单位像素；界面不再编辑，新建不初始化。 */
  height?: number;
  /** 上游音色 ID，空值时省略，不由 Canvas 收窄音色集合。 */
  voice?: string;
  /** TTS 输出格式；新建或切换模型时可初始化为支持列表中的第一项，清空后省略。 */
  response_format?: string;
  /** TTS 语速倍率，有限数值；未设置时省略，上游判断适用范围。 */
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
  /** 节点级停止状态；创建请求尚未返回 Run 时也可立即记录停止意图。 */
  runControlStore?: NodeRunControlStore;
  /** 旧纯文本提示词回调；有结构化回调时可省略。 */
  onPromptChange?: (value: string) => void;
  /** 保存节点的结构化提示词文档。 */
  onPromptDocumentChange?: (document: PromptDocument) => void;
  /** 提示词资源条点击上传后，把本地文件收成项目资源。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 将上传素材加入节点资料条；保留提示词正文，不触发生成。 */
  onResourceAttach?: (asset: Asset) => void;
  /** 修改复刻工作流配置；资源引用与生成提示词由父层原子更新。 */
  onVideoRecreationChange?: (config: VideoRecreationConfig) => void | Promise<void>;
  /** 当前节点连续添加画布参考资源的开关；不触发生成。 */
  referencePickActive?: boolean;
  onReferencePickToggle?: () => void;
  /** 按当前项目在服务端分页搜索；未提供时兼容使用传入的完整目录。 */
  onSearchProjectResources?: ProjectResourceSearch;
  /** 保存资源条的完整版本化顺序，不移动正文引用。 */
  onResourceReorder?: (resources: readonly { assetId: string; assetVersion?: number }[]) => void;
  /** 一次移除资源连线及引用，文档保留全部可见文字。 */
  onResourceRemove?: (
    resource: { assetId: string; assetVersion?: number },
    document: PromptDocument,
  ) => void;
  /** 当前项目可访问资源，用于提示词中的 `@` 搜索。 */
  assets?: readonly Asset[];
  onModelChange: (value: ModelSelection) => void;
  onInferenceStrengthChange: (value: InferenceStrength) => void;
  onRun: () => void;
  /** 停止当前节点关联的本次操作，不保证 Provider 远端任务终止或退款。 */
  onStop?: () => void | Promise<void>;
  /** 有回显时把修改结果写到新建子节点并立刻运行。 */
  onRunNewNode?: () => void;
  /** 当前节点是否有可供转换/生成的连线输入。 */
  hasConnectedInput?: boolean;
  /**
   * 来源为文字且连接 prompt/content 的输入，用于 H3 必填正文校验。
   * content 文字角色保留旧无 videoMode 画布的语义，不将视频或音频参考当作提示词。
   */
  hasConnectedTextPromptInput?: boolean;
  /** 显式连接到当前节点的输入文件，供完整编辑器展示。 */
  connectedAssets?: readonly ConnectedPromptAsset[];
  /** 保存当前节点的连线资源别名，不重命名源资源。 */
  onConnectedResourceRename?: (assetId: string, name: string, assetVersion?: number) => void;
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
  trailingLabel?: string;
};

/** 旧 K 档仅用于兼容目录；菜单值和新保存值始终是完整像素。 */
const legacyImageResolutionTiers: MediaOption[] = [
  { value: '1k', label: '1k', description: '标准' },
  { value: '2k', label: '2k', description: '高清' },
  { value: '3k', label: '3k', description: '超清' },
  { value: '4k', label: '4k', description: '极致' },
];

/** 图片尺寸兼容字段；显式编辑后只保留官方 size。 */
const imageSizeParameterAliases = ['size', 'image_size', 'imageSize', 'resolution'] as const;

/** 供应商质量兼容字段；新编辑会把真实质量收敛到 quality。 */
const imageQualityParameterAliases = ['quality', 'image_quality', 'imageQuality'] as const;

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

/** 固定时长滑块的秒数范围；不扩大模型合同，旧值只在用户拖动时改变。 */
const VIDEO_DURATION_RANGE = { min: 5, max: 30, default: 10 } as const;

/** 自动比例按模型根据提示词和输入素材决定；强制沿用素材的模式另显示原素材标签。 */
const adaptiveVideoAspectRatioOption: MediaOption = {
  value: 'adaptive',
  label: '自动比例',
  description: '由模型根据提示词和素材决定',
};

/** Provider 已支持的 TTS 格式，空选项仅用于移除显式配置。 */
const AUDIO_FORMAT_OPTIONS: MediaOption[] = [
  { value: '', label: '未设置' },
  ...['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map((value) => ({
    value,
    label: value.toUpperCase(),
  })),
];

/** 与 Provider 契约一致的连续语速范围，不将用户值静默截断或量化。 */

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
  runControlStore,
  onPromptChange,
  onPromptDocumentChange,
  onUploadResource,
  onResourceAttach,
  onVideoRecreationChange,
  referencePickActive,
  onReferencePickToggle,
  onSearchProjectResources,
  onResourceReorder,
  onResourceRemove,
  assets = [],
  onModelChange,
  onInferenceStrengthChange,
  onRun,
  onStop,
  onRunNewNode,
  hasConnectedInput = false,
  hasConnectedTextPromptInput = false,
  connectedAssets = [],
  onConnectedResourceRename,
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
  const runControl = useNodeRunControl(runControlStore, node.id);
  const canStop = busy && runControl.stoppable && Boolean(onStop);
  const showImageEditSourceCard = useWorkspacePreferences((state) => state.showImageEditSourceCard);
  const setShowImageEditSourceCard = useWorkspacePreferences(
    (state) => state.setShowImageEditSourceCard,
  );
  /** 参数页只改变展示状态，不修改节点或默认参数。 */
  const [mediaSettingsOpen, setMediaSettingsOpen] = useState(false);
  /** 同一节点在快速面板和 Dialog 之间共用父层保存的文档。 */
  const [expandedEditorOpen, setExpandedEditorOpen] = useState(false);
  /** 参数页 Escape 关闭后的回焦目标；外点关闭不干预用户正在操作的控件。 */
  const mediaSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const expandTriggerRef = useRef<HTMLButtonElement>(null);
  const expandedDialogRef = useRef<HTMLDivElement>(null);
  const dialogTitleId = useId();

  /** 关闭参数配置不改变已持久化参数。 */
  const closeMediaSettings = () => setMediaSettingsOpen(false);
  const storedModelAlias = node.data.modelAlias ?? '';
  const currentCredentialId = node.data.credentialId;
  const availableModels = models;
  const selectedModel = findSelectedModel(availableModels, storedModelAlias, currentCredentialId);
  const currentModel = storedModelAlias;
  const currentModelIsMissing =
    Boolean(currentModel) &&
    !availableModels.some(
      (model) => model.id === currentModel && model.credentialId === currentCredentialId,
    );
  const currentModelValue = currentModel
    ? modelOptionValue({
        modelAlias: currentModel,
        credentialId: currentCredentialId,
      })
    : '';
  const modelOptions = buildModelOptions(
    availableModels,
    node.data.mediaType,
    currentModelValue,
    currentModel,
    currentCredentialId,
    currentModelIsMissing,
  );
  const parameters = readNodeMediaParameters(node.data);
  let imageOutputParameters: ImageOutputParameters | undefined;
  let imageOutputParameterIssue: string | undefined;
  const compatibleImageOutputParameters =
    node.data.mediaType === 'image' ? readCompatibleImageOutputParameters(parameters) : undefined;
  if (node.data.mediaType === 'image') {
    try {
      imageOutputParameters = resolveImageOutputParameters(parameters, currentModel);
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
      imageOutputParameterIssue = error.message;
    }
  }
  const storedDuration = parameters.duration ?? parameters.seconds ?? parameters.durationSeconds;
  const storedAspectRatio = parameters.aspectRatio ?? parameters.aspect_ratio ?? parameters.ratio;
  /** 数量选择即时显示；切换节点同步已存值，非法历史值仍阻止运行。 */
  const [generationCountDraft, setGenerationCountDraft] = useState(
    String(node.data.generationCount ?? DEFAULT_GENERATION_COUNT),
  );
  /** 历史空值和秒数原样回显；滑块或显式清除才写回，不在渲染时补默认值。 */
  const [durationDraft, setDurationDraft] = useState(
    storedDuration === undefined ? '' : String(storedDuration),
  );
  useEffect(() => {
    setGenerationCountDraft(String(node.data.generationCount ?? DEFAULT_GENERATION_COUNT));
  }, [node.id, node.data.generationCount]);
  useEffect(() => {
    setDurationDraft(storedDuration === undefined ? '' : String(storedDuration));
  }, [node.id, storedDuration]);
  const generationCountIssue = isValidGenerationCount(Number(generationCountDraft))
    ? undefined
    : `生成数量必须为 1 至 ${GENERATION_COUNT_MAX} 的整数`;
  const durationValue = Number(durationDraft);
  const durationIssue =
    node.data.mediaType === 'video' &&
    durationDraft !== '' &&
    (!Number.isFinite(durationValue) || (durationValue <= 0 && durationValue !== -1))
      ? '视频时长必须为正数秒，或使用 -1 自动时长'
      : undefined;
  const mediaOptions = getMediaOptions(
    selectedModel,
    node.data.mediaType,
    parameters,
    true,
    currentModel,
  );
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
  const imageEditSourceIssue = imageEditSource?.versionUnavailable
    ? '来源图已不可读取或版本已变更，请重新从图片节点创建修改节点'
    : undefined;
  const recreationIssue = recreationGenerationIssue(node.data);
  const mediaParameterIssue =
    recreationIssue ??
    imageOutputParameterIssue ??
    durationIssue ??
    (node.data.mediaType === 'audio'
      ? getAudioParameterIssue(parameters)
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

  /** 显式编辑时收敛该控件的同义字段，其它参数原样保留。 */
  const updateVideoParameter = (key: 'duration' | 'aspectRatio' | 'resolution', value: unknown) => {
    if (!onParametersChange) return;
    const next: Record<string, unknown> = { ...parameters };
    const aliases =
      key === 'duration'
        ? ['duration', 'seconds', 'durationSeconds']
        : key === 'resolution'
          ? ['resolution', 'video_resolution', 'videoResolution']
          : ['aspectRatio', 'aspect_ratio', 'ratio'];
    for (const alias of aliases) delete next[alias];
    if (value !== undefined && value !== '') next[key] = value;
    onParametersChange(next);
  };

  /**
   * 图片参数只有在用户明确编辑时收敛为官方 size 和原生 quality。
   * 未知供应商字段原样保留；旧 K 档和比例别名不会继续写回新数据。
   */
  const updateImageParameter = (key: 'size' | 'aspectRatio' | 'quality', value: string) => {
    if (!onParametersChange) return;
    const currentSize = compatibleImageOutputParameters?.size;
    const nativeQuality = readNativeImageQuality(parameters);
    let nextSize = currentSize;
    let nextQuality = nativeQuality;
    if (key === 'size') nextSize = value || undefined;
    if (key === 'aspectRatio') {
      const longEdge = compatibleImageOutputParameters
        ? Math.max(
            compatibleImageOutputParameters.width ?? 0,
            compatibleImageOutputParameters.height ?? 0,
          ) || 1024
        : 1024;
      nextSize = imageSizeForRatio(longEdge, value, currentModel)?.size;
      if (!nextSize) {
        const next = canonicalImageParameters(parameters, currentSize, nativeQuality);
        delete next.aspect_ratio;
        delete next.ratio;
        next.aspectRatio = value;
        onParametersChange(next);
        return;
      }
    }
    if (key === 'quality') nextQuality = value || undefined;
    onParametersChange(canonicalImageParameters(parameters, nextSize, nextQuality));
  };

  /** 推理强度对文字节点直接显示，对媒体节点收进参数页。 */
  const inferenceEditor = (
    <NodeParameterSelect
      label="推理强度"
      value={node.data.inferenceStrength}
      options={inferenceOptions}
      onChange={onInferenceStrengthChange}
      className="node-quick-editor-select-group"
      allowCustomValue
    />
  );

  const promptEditor = (
    <div className="node-quick-editor-field node-quick-editor-prompt">
      <TextPromptEditor
        nodeId={node.id}
        value={node.data.prompt ?? ''}
        promptDocument={node.data.promptDocument}
        assets={assets}
        onSearchProjectResources={onSearchProjectResources}
        connectedAssets={connectedAssets}
        onConnectedResourceRename={onConnectedResourceRename}
        placeholder={
          imageEditSource ? '想用这张图修改什么？例如：换成夜景、去掉背景' : '描述你想生成的内容'
        }
        ariaLabel={imageEditSource ? '图片修改要求' : '提示词'}
        onChange={onPromptDocumentChange ? undefined : onPromptChange}
        onDocumentChange={onPromptDocumentChange}
        onUploadResource={onUploadResource}
        onResourceAttach={onResourceAttach}
        referencePickActive={referencePickActive}
        onReferencePickToggle={
          onReferencePickToggle
            ? () => {
                if (expandedEditorOpen) setExpandedEditorOpen(false);
                onReferencePickToggle();
              }
            : undefined
        }
        resourceRefs={node.data.resourceRefs}
        onResourceReorder={onResourceReorder}
        onResourceRemove={onResourceRemove}
      />
    </div>
  );

  /** 与提示词编辑器共用结构化文档，采用时走现有历史和保存回调。 */
  const skillPanelProps: PromptSkillPanelProps = {
    nodeId: node.id,
    projectId,
    mediaType: node.data.mediaType,
    promptDocument: node.data.promptDocument ?? {
      version: 1,
      blocks: [{ type: 'text', text: node.data.prompt ?? '' }],
    },
    skillId: node.data.promptSkillId,
    skills: promptSkills,
    skillsLoading: skillLibraryLoading,
    skillsError: skillLibraryError,
    onOpenWorkbench: onOpenSkillWorkbench,
    models,
    disabled: busy || !onPromptSkillChange || Boolean(skillLibraryError),
    applyMode: 'direct',
    onSkillChange: (id) => onPromptSkillChange?.(id),
    onApply: (document) => {
      if (onPromptDocumentChange) onPromptDocumentChange(document);
      else onPromptChange?.(renderPromptDocument(document));
    },
    onUndo: (document) => {
      if (onPromptDocumentChange) onPromptDocumentChange(document);
      else onPromptChange?.(renderPromptDocument(document));
    },
  };
  const skillPanel = <PromptSkillPanel {...skillPanelProps} />;

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
          <Button
            type="button"
            className="node-quick-editor-image-edit-name nodrag nopan"
            onClick={() => onFocusImageEditSource?.(imageEditSource.sourceNodeId)}
          >
            {imageEditSource.name}
          </Button>
          <span>
            来源图固定版本：
            {imageEditSource.version ? `v${imageEditSource.version}` : '运行前冻结'}
          </span>
        </span>
        <Button
          type="button"
          className="node-quick-editor-image-edit-hide nodrag nopan"
          aria-label="隐藏来源图"
          title="隐藏来源图"
          onClick={() => setShowImageEditSourceCard(false)}
        >
          <EyeOff size={15} aria-hidden="true" />
        </Button>
      </div>
    ) : null;

  /** 切换模式只保存用户选择，不改写已保存的媒体参数。 */
  const changeVideoMode = (nextMode: VideoMode) => onVideoModeChange?.(nextMode);

  /** 视频模式在快速编辑器控制栏常驻，避免用户为切换模式打开参数页。 */
  const videoModeEditor =
    node.data.mediaType === 'video' ? (
      <NodeParameterSelect
        label="生成模式"
        value={displayVideoMode(node.data, connectedInputRoles)}
        options={videoModes.map((mode) => ({
          value: mode,
          label: videoModeLabels[mode],
          description: videoModeDescriptions[mode],
        }))}
        onChange={(value) => changeVideoMode(value as VideoMode)}
        className="node-quick-editor-select-group node-quick-editor-video-mode"
      />
    ) : null;

  const mediaParameterEditor = (
    <div className="node-quick-editor-media-settings">
      {imageEditSource ? (
        <Checkbox
          className="node-quick-editor-source-card-toggle"
          checked={showImageEditSourceCard}
          onChange={(event) => setShowImageEditSourceCard(event.target.checked)}
          aria-label="显示来源图"
        >
          显示来源图
        </Checkbox>
      ) : null}
      {node.data.mediaType === 'image' && (
        <div
          className="node-quick-editor-media-options"
          data-columns="2"
          role="group"
          aria-label="媒体参数"
        >
          <NodeParameterSelect
            label="图片分辨率"
            allowCustomValue
            value={mediaOptions.imageResolutionValue}
            options={mediaOptions.resolution}
            onChange={(value) => updateImageParameter('size', value)}
            className="node-quick-editor-select-group"
            optionLayout="grid"
          />
          <QuickOptionMenu
            label="图片比例"
            value={mediaOptions.imageAspectRatioValue}
            options={mediaOptions.aspectRatio}
            aspectOptions
            onChange={(value) => updateImageParameter('aspectRatio', value)}
          />
          {mediaOptions.hasNativeImageQuality && (
            <NodeParameterSelect
              label="生成质量"
              allowCustomValue
              value={imageOutputParameters?.quality ?? readNativeImageQuality(parameters) ?? ''}
              options={mediaOptions.quality}
              onChange={(value) => updateImageParameter('quality', value)}
              className="node-quick-editor-select-group"
            />
          )}
          <p
            className="node-quick-editor-image-size"
            title="发送给图片接口的请求像素；实际输出取决于上游对该尺寸的支持。"
          >
            <span>请求像素</span>
            <output aria-label="请求像素" aria-live="polite">
              {imageOutputParameters?.size
                ? imageOutputParameters.size === 'auto'
                  ? '自动'
                  : imageOutputParameters.size.replace('x', ' × ')
                : imageOutputParameterIssue
                  ? '请修正参数'
                  : '未设置'}
            </output>
          </p>
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
            <NodeParameterSelect
              label="视频清晰度"
              allowCustomValue
              value={normalizeCurrentOptionValue(
                parameters.resolution ?? parameters.video_resolution ?? parameters.videoResolution,
              )}
              options={mediaOptions.resolution}
              onChange={(value) => updateVideoParameter('resolution', value)}
              className="node-quick-editor-select-group"
              optionLayout="grid"
            />
            <QuickOptionMenu
              label="视频比例"
              value={storedAspectRatio}
              options={mediaOptions.aspectRatio}
              aspectOptions
              onChange={(value) => updateVideoParameter('aspectRatio', value)}
            />
            <VideoDurationControl
              value={durationDraft}
              issue={durationIssue}
              inputDisabled={!onParametersChange}
              onChange={(value) => {
                setDurationDraft(value);
                if (value === '') updateVideoParameter('duration', undefined);
                else if (
                  Number.isFinite(Number(value)) &&
                  (Number(value) > 0 || Number(value) === -1)
                )
                  updateVideoParameter('duration', Number(value));
              }}
            />
            <NodeParameterSelect
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
            />
            {resolveVideoCompletionAction(node.data) === 'fill_designated_image_node' ? (
              <NodeParameterSelect
                label="填充目标"
                value={node.data.completionTargetNodeId ?? ''}
                options={[
                  { value: '', label: '未指定' },
                  ...emptyImageNodes.map((item) => ({ value: item.id, label: item.label })),
                ]}
                onChange={(value) => onCompletionTargetNodeIdChange?.(value || undefined)}
                className="node-quick-editor-select-group"
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
            <Input
              className="compact-select-trigger"
              style={{ cursor: 'text' }}
              type="text"
              value={typeof parameters.voice === 'string' ? parameters.voice : ''}
              placeholder="输入音色 ID"
              title="填写上游音色 ID；留空时由上游处理"
              disabled={!onParametersChange}
              onChange={(event) =>
                updateParameter(
                  'voice',
                  event.currentTarget.value.trim() ? event.currentTarget.value : undefined,
                )
              }
            />
          </label>
          <NodeParameterSelect
            label="音频格式"
            allowCustomValue
            value={normalizeCurrentOptionValue(parameters.response_format)}
            options={getAudioFormatOptions(parameters.response_format, selectedModel)}
            onChange={(value) => updateParameter('response_format', value)}
            disabled={!onParametersChange}
            className="node-quick-editor-select-group"
          />
          <label className="compact-select node-quick-editor-select-group">
            <span className="compact-select-label">语速</span>
            <Input
              className="compact-select-trigger"
              style={{ cursor: 'text' }}
              type="number"
              inputMode="decimal"
              step="any"
              value={
                typeof parameters.speed === 'number' && Number.isFinite(parameters.speed)
                  ? parameters.speed
                  : typeof parameters.speed === 'string'
                    ? parameters.speed
                    : ''
              }
              placeholder="语速倍率"
              aria-invalid={
                parameters.speed !== undefined &&
                (typeof parameters.speed !== 'number' || !Number.isFinite(parameters.speed))
              }
              title="发送给上游的语速倍率"
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
  const summaryItems = getMediaSummary(node.data.mediaType, parameters, {
    ...mediaOptions,
    imageResolutionValue:
      compatibleImageOutputParameters?.size ?? mediaOptions.imageResolutionValue,
  });
  /** 容器级 Popover 为秒数及 Select 提供库层级上下文，避免子浮层落到参数页下面。 */
  const mediaSummary =
    node.data.mediaType === 'text' ? null : (
      <Popover
        trigger={['click']}
        placement="topRight"
        open={mediaSettingsOpen}
        onOpenChange={setMediaSettingsOpen}
        arrow={false}
        styles={{
          root: { pointerEvents: 'auto' },
          container: { padding: 0, background: 'transparent', boxShadow: 'none' },
        }}
        getPopupContainer={nodePopupContainer}
        classNames={{ root: 'node-quick-editor-parameter-overlay' }}
        destroyOnHidden
        content={
          <div
            className="node-quick-editor-parameter-popover"
            tabIndex={-1}
            role="region"
            aria-label="生成参数"
            onKeyDownCapture={(event) => {
              // 输入法候选操作不能被浮层解释为关闭。
              if (isImeKeyboardEvent(event)) event.stopPropagation();
            }}
            onKeyDown={(event) => {
              // 子 Select/秒数先拦截自己的 Escape；剩下的按键只关闭参数页并归还焦点。
              if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
              event.preventDefault();
              event.stopPropagation();
              closeMediaSettings();
              mediaSettingsTriggerRef.current?.focus({ preventScroll: true });
            }}
          >
            <div className="node-quick-editor-parameter-heading">
              <strong>生成参数</strong>
              <Button type="button" aria-label="收起媒体参数" onClick={closeMediaSettings}>
                <X size={15} aria-hidden="true" />
              </Button>
            </div>
            {mediaParameterEditor}
          </div>
        }
      >
        <Button
          ref={mediaSettingsTriggerRef}
          type="button"
          className="node-quick-editor-summary-button"
          aria-expanded={mediaSettingsOpen}
          aria-label="媒体参数"
          title={summaryItems.map((item) => item.label + '：' + item.value).join(' · ')}
        >
          <SlidersHorizontal size={15} aria-hidden="true" />
          <span>{summaryItems.map((item) => item.value).join(' · ')}</span>
        </Button>
      </Popover>
    );

  /** 设置先于输入框渲染，使键盘导航与顶部布局顺序一致。 */
  const topControls = (
    <div className="node-quick-editor-controls node-quick-editor-topbar">
      <div className="node-quick-editor-settings">
        <NodeParameterSelect
          label="模型"
          value={currentModelValue}
          options={modelOptions}
          onChange={(value) => onModelChange(parseModelOptionValue(value))}
          className="node-quick-editor-select-group"
        />
        {videoModeEditor}
        {node.data.mediaType === 'text' ? inferenceEditor : mediaSummary}
      </div>
      {!expandedEditorOpen && (
        <Button
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
        </Button>
      )}
    </div>
  );

  const controls = (
    <div className="node-quick-editor-controls">
      <div className="node-quick-editor-run-group">
        {!node.data.videoRecreation && skillPanel}
        <NodeParameterSelect
          label="生成数量"
          className="node-quick-editor-generation-count"
          value={generationCountDraft}
          options={Array.from({ length: GENERATION_COUNT_MAX }, (_, index) => ({
            value: String(index + 1),
            label: `${index + 1}份`,
          }))}
          disabled={busy || !onGenerationCountChange}
          onChange={(value) => {
            if (value === generationCountDraft) return;
            setGenerationCountDraft(value);
            onGenerationCountChange?.(Number(value));
          }}
        />
        {canStop ? (
          <Button
            type="button"
            className="button button-primary node-quick-editor-run"
            aria-label={runControl.stopRequested ? '停止中' : '停止生成'}
            title={
              runControl.stopRequested
                ? '正在停止；不保证远端任务终止或退款'
                : '停止本地后续提交并取消已知运行；不保证远端任务终止或退款'
            }
            onClick={() => void onStop?.()}
            disabled={runControl.stopRequested}
          >
            {runControl.stopRequested ? (
              <LoaderCircle className="spin" size={16} aria-hidden="true" />
            ) : (
              <Square size={16} aria-hidden="true" />
            )}
            <span>{runControl.stopRequested ? '停止中' : '停止'}</span>
          </Button>
        ) : (
          <>
            {canRunSameNode(node) ? (
              <Button
                type="button"
                className="button button-primary node-quick-editor-run"
                aria-label={busy ? '生成中' : '生成'}
                title={
                  busy
                    ? '生成中'
                    : !enabled
                      ? '节点已停用'
                      : (generationCountIssue ??
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
                  Boolean(generationCountIssue || mediaParameterIssue)
                }
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} aria-hidden="true" />
                ) : (
                  <Play size={16} aria-hidden="true" />
                )}
                <span>{busy ? '生成中' : '生成'}</span>
              </Button>
            ) : null}
            {canForkNewNode(node) ? (
              <Button
                type="button"
                className="button node-quick-editor-run node-quick-editor-run-new"
                aria-label="新节点"
                title={
                  busy
                    ? '生成中'
                    : !enabled
                      ? '节点已停用'
                      : !currentModel
                        ? '请先选择本人可用的分组模型'
                        : generationCountIssue || durationIssue || mediaParameterIssue
                          ? (generationCountIssue ?? durationIssue ?? mediaParameterIssue)
                          : !nodeHasPrompt(node.data)
                            ? '请先填写提示词'
                            : mediaParameterIssue
                              ? mediaParameterIssue
                              : '把修改结果写到新节点'
                }
                onClick={() => onRunNewNode?.()}
                disabled={
                  busy ||
                  !enabled ||
                  !onRunNewNode ||
                  !currentModel ||
                  Boolean(generationCountIssue || durationIssue || mediaParameterIssue) ||
                  !nodeHasPrompt(node.data) ||
                  Boolean(mediaParameterIssue)
                }
              >
                <GitFork size={16} aria-hidden="true" />
                <span>新节点</span>
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );

  const recreationPanel =
    node.data.videoRecreation && projectId && onVideoRecreationChange ? (
      <VideoRecreationPanel
        key={
          node.data.videoRecreation.source.assetId +
          ':' +
          node.data.videoRecreation.source.assetVersion
        }
        projectId={projectId}
        config={node.data.videoRecreation}
        assets={assets}
        models={models}
        busy={busy}
        onChange={onVideoRecreationChange}
        onUploadResource={onUploadResource}
      />
    ) : null;
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
            {recreationPanel}
            {topControls}
            <div className="node-quick-editor-prompt-group">
              {imageEditSourcePreview}
              {promptEditor}
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
        <DialogContent
          ref={expandedDialogRef}
          className="node-quick-editor-dialog"
          overlayClassName="node-quick-editor-dialog-backdrop"
          aria-labelledby={dialogTitleId}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const dialog = expandedDialogRef.current;
            // 库默认落在首个关闭按钮；动画结束只修正默认落点，不抢走其他业务控件焦点。
            if (
              dialog &&
              (document.activeElement === dialog ||
                document.activeElement?.matches('.node-quick-editor-dialog-close') ||
                !dialog.contains(document.activeElement))
            ) {
              dialog
                .querySelector<HTMLElement>('.resource-mention-input')
                ?.focus({ preventScroll: true });
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            expandTriggerRef.current?.focus();
          }}
          onEscapeKeyDown={(event) => {
            // 子浮层先处理 Escape，不能同时关闭完整编辑器。
            if (
              isImeKeyboardEvent(event) ||
              mediaSettingsOpen ||
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
              <Button
                type="button"
                className="node-quick-editor-dialog-close"
                aria-label="关闭编辑器"
                title="关闭"
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </DialogClose>
          </div>
          <div className="node-quick-editor-dialog-body">
            {expandedEditorOpen && recreationPanel}
            {topControls}
            <div className="node-quick-editor-prompt-group">{promptEditor}</div>
            {controls}
            {generationCountIssue && (
              <p className="node-quick-editor-parameter-issue" role="status">
                {generationCountIssue}
              </p>
            )}
          </div>
        </DialogContent>
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
      {
        label: '分辨率',
        value: formatImageSize(options.imageResolutionValue) || '未设置',
      },
      {
        label: '比例',
        value: options.imageAspectRatioValue || '未设置',
      },
    ];
  }
  if (mediaType === 'video') {
    const duration = parameters.duration ?? parameters.seconds ?? parameters.durationSeconds;
    return [
      ...(options.videoResolutionSupported
        ? [
            {
              label: '清晰度',
              value: getOptionLabel(parameters.resolution, options.resolution, '未设置'),
            },
          ]
        : []),
      {
        label: '比例',
        value: getOptionLabel(
          parameters.aspectRatio ?? parameters.aspect_ratio ?? parameters.ratio,
          options.aspectRatio,
          '未设置',
        ),
      },
      {
        label: '时长',
        value:
          duration === -1
            ? getOptionLabel(duration, options.duration, '自动')
            : duration
              ? `${duration}s`
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

/**
 * 用共享解析器区分图片 K 档与历史像素别名，不根据模型名或标签推算尺寸。
 * @returns 合法字段的解析值；无效字段留给完整参数校验展示错误，不隐藏原始节点数据。
 */
function readImageResolutionParameter(value: unknown): ImageOutputParameters | undefined {
  if (typeof value !== 'string' || !/^(?:[1-4]k|\d+x\d+|auto)$/i.test(value.trim()))
    return undefined;
  try {
    return resolveImageOutputParameters({ resolution: value });
  } catch (error) {
    if (!(error instanceof ImageOutputParameterError)) throw error;
    return undefined;
  }
}

/**
 * 兼容读取旧图片参数并返回完整像素；冲突数据优先使用旧 K 档帮助用户显式修复。
 * @param parameters 节点保存的原始图片参数。
 * @returns 可用于只读显示和编辑迁移的尺寸；完全无法解析时返回 undefined。
 */
function readCompatibleImageOutputParameters(
  parameters: NodeMediaParameters,
): ImageOutputParameters | undefined {
  try {
    return resolveImageOutputParameters(parameters);
  } catch (error) {
    if (!(error instanceof ImageOutputParameterError)) throw error;
  }
  const aspectRatio = normalizeCurrentOptionValue(
    parameters.aspectRatio ?? parameters.aspect_ratio,
  );
  for (const alias of ['resolution', ...imageQualityParameterAliases] as const) {
    const resolution = readImageResolutionParameter(parameters[alias])?.resolution;
    if (!resolution) continue;
    try {
      return resolveImageOutputParameters({
        resolution,
        ...(aspectRatio ? { aspectRatio } : {}),
      });
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
    }
  }
  for (const alias of imageSizeParameterAliases) {
    try {
      return resolveImageOutputParameters({ size: parameters[alias] });
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
    }
  }
  return undefined;
}

/** 从 quality 及兼容别名中读取真实供应商质量，旧 K 档不作为 quality 返回。 */
function readNativeImageQuality(parameters: NodeMediaParameters): string | undefined {
  for (const alias of imageQualityParameterAliases) {
    const value = parameters[alias];
    if (value === undefined) continue;
    try {
      const parsed = resolveImageOutputParameters({ [alias]: value });
      if (parsed.quality) return parsed.quality;
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
    }
  }
  return undefined;
}

/**
 * 把图片参数收敛为官方 size 与原生 quality，保留所有未知供应商字段。
 * @param parameters 原始节点参数；函数不修改输入。
 * @param size 新的官方尺寸；undefined 表示不配置图片尺寸。
 * @param quality 供应商原生质量；undefined 表示不配置质量。
 * @returns 可直接保存的新参数对象，不再包含图片尺寸、比例或质量别名。
 */
function canonicalImageParameters(
  parameters: NodeMediaParameters,
  size: string | undefined,
  quality: string | undefined,
): NodeMediaParameters {
  const next = { ...parameters };
  for (const alias of imageSizeParameterAliases) delete next[alias];
  for (const alias of imageQualityParameterAliases) delete next[alias];
  delete next.aspectRatio;
  delete next.aspect_ratio;
  if (size) next.size = size;
  if (quality) next.quality = quality;
  return normalizeImageOutputParameters(next) as NodeMediaParameters;
}

/** 按当前菜单比例和长边生成 16 px 对齐尺寸，并由共享解析器校验精确模型。 */
function imageSizeForRatio(
  longEdge: number,
  aspectRatio: string,
  modelAlias?: string,
): ImageOutputParameters | undefined {
  const match = /^(\d+)\s*:\s*(\d+)$/.exec(aspectRatio);
  const horizontal = Number(match?.[1]);
  const vertical = Number(match?.[2]);
  if (
    !Number.isSafeInteger(longEdge) ||
    longEdge <= 0 ||
    !Number.isSafeInteger(horizontal) ||
    !Number.isSafeInteger(vertical) ||
    horizontal <= 0 ||
    vertical <= 0
  )
    return undefined;
  const shortEdge =
    Math.round((longEdge * Math.min(horizontal, vertical)) / Math.max(horizontal, vertical) / 16) *
    16;
  if (!Number.isSafeInteger(shortEdge) || shortEdge <= 0) return undefined;
  const width = horizontal >= vertical ? longEdge : shortEdge;
  const height = horizontal >= vertical ? shortEdge : longEdge;
  try {
    return resolveImageOutputParameters({ size: `${width}x${height}` }, modelAlias);
  } catch (error) {
    if (!(error instanceof ImageOutputParameterError)) throw error;
    return undefined;
  }
}

/**
 * 用共享解析器的 8 px 容差从实际像素反推菜单比例，兼容 3840x1648 等对齐尺寸。
 * @param size 官方 WIDTHxHEIGHT 尺寸。
 * @returns 首个匹配的固定比例；自动或自定义比例返回 undefined。
 */
function imageAspectRatioForSize(size: string | undefined): string | undefined {
  if (!size || size === 'auto') return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return undefined;
  for (const option of aspectRatioOptions) {
    const ratio = /^([0-9]+(?:\.[0-9]+)?):([0-9]+(?:\.[0-9]+)?)$/.exec(option.value);
    if (!ratio) continue;
    const expected = Number(ratio[1]) / Number(ratio[2]);
    const actual = width / height;
    if (Math.abs(actual - expected) <= 8 / Math.max(width, height)) return option.value;
  }
  return undefined;
}

/** 将保存值或菜单值格式化为用户可读的完整像素，不显示历史 K 档。 */
function formatImageSize(value: unknown): string {
  const normalized = normalizeCurrentOptionValue(value);
  if (normalized === 'auto') return '自动';
  const match = /^(\d+)x(\d+)$/.exec(normalized);
  return match ? `${match[1]} × ${match[2]}` : '';
}

/** 把目录 K 档或原生像素转换成唯一的官方 size 菜单项。 */
function imageSizeOption(
  option: MediaOption,
  aspectRatio: string,
  modelAlias?: string,
): MediaOption | undefined {
  const compatible = readImageResolutionParameter(option.value);
  if (normalizeCurrentOptionValue(option.value).toLowerCase() === 'auto') {
    return {
      value: 'auto',
      label: '自动',
      ...(option.description ? { description: option.description } : {}),
    };
  }
  if (!compatible?.size) return undefined;
  let size = compatible.size;
  if (compatible.resolution) {
    try {
      size = resolveImageOutputParameters({
        resolution: compatible.resolution,
        aspectRatio,
      }).size!;
    } catch (error) {
      if (!(error instanceof ImageOutputParameterError)) throw error;
      return undefined;
    }
  }
  const tierDescription = compatible.resolution
    ? legacyImageResolutionTiers.find((candidate) => candidate.value === compatible.resolution)
        ?.description
    : undefined;
  const catalogDescription = option.description?.match(/\b[1-4]k\b/i)
    ? undefined
    : option.description;
  return {
    value: size,
    label: formatImageSize(size),
    ...(catalogDescription || tierDescription
      ? { description: catalogDescription ?? tierDescription }
      : {}),
  };
}

/** 依目录顺序转换并去重图片尺寸，避免 K 档与像素枚举生成重复菜单项。 */
function imageSizeOptions(
  options: readonly MediaOption[],
  aspectRatio: string,
  modelAlias?: string,
): MediaOption[] {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const mapped = imageSizeOption(option, aspectRatio, modelAlias);
    if (!mapped || seen.has(mapped.value)) return [];
    seen.add(mapped.value);
    return [mapped];
  });
}

/** 验证音频参数的可序列化格式，不依据目录限制音色、格式或倍率。 */
export function getAudioParameterIssue(parameters: NodeMediaParameters): string | undefined {
  if (parameters.voice !== undefined && typeof parameters.voice !== 'string')
    return '音色必须为字符串';
  if (parameters.response_format !== undefined && typeof parameters.response_format !== 'string')
    return '音频格式必须为字符串';
  if (
    parameters.speed !== undefined &&
    (typeof parameters.speed !== 'number' || !Number.isFinite(parameters.speed))
  )
    return '语速必须为有限数值';
  return undefined;
}

/** 常用格式、目录建议和已保存格式都可再次选择。 */
function getAudioFormatOptions(value: unknown, model?: ModelEntry): MediaOption[] {
  return ensureCurrentOption(getSupportedAudioFormatOptions(model), value, 'resolution');
}

/** 目录补充音频格式建议，不收窄用户选择。 */
function getSupportedAudioFormatOptions(model?: ModelEntry): MediaOption[] {
  const declared =
    readCapabilityOptions(
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
    ) ?? [];
  return mergeOptions(AUDIO_FORMAT_OPTIONS, declared);
}

/** 将节点浮层挂到最近的模态窗口，非模态编辑器使用 body，避免画布裁切。 */
function nodePopupContainer(trigger: HTMLElement): HTMLElement {
  return trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body;
}

/**
 * 视频滑块提供 5–30 秒快捷编辑，输入框可保存其它秒数；适用范围交给上游。
 * value 为实际保存值，历史空值、范围外值和自动 -1 不因打开浮卡而改写。
 * hover 不抢焦点；键盘进入后聚焦滑块，Escape 只关闭本层并归还焦点。
 */
function VideoDurationControl({
  value,
  issue,
  inputDisabled,
  onChange,
}: {
  value: string;
  issue?: string;
  inputDisabled: boolean;
  onChange: (value: string) => void;
}) {
  const popupId = useId();
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const focusOnOpenRef = useRef(false);
  const automatic = value === '-1';
  const sliderMin = VIDEO_DURATION_RANGE.min;
  const sliderMax = VIDEO_DURATION_RANGE.max;
  const sliderDefault = VIDEO_DURATION_RANGE.default;
  const selectionLabel = value === '' ? '未设置' : automatic ? '自动' : value + ' 秒';
  const seconds = Number(value);
  const fixedDuration = value !== '' && Number.isSafeInteger(seconds) && seconds > 0;
  const outsideSlider = fixedDuration && (seconds < sliderMin || seconds > sliderMax);
  const sliderValue = fixedDuration
    ? Math.min(sliderMax, Math.max(sliderMin, seconds))
    : sliderDefault;
  const hint =
    value === ''
      ? `未设置；滑块从 ${sliderDefault} 秒起，拖动后才保存。`
      : automatic
        ? '当前为自动时长；拖动后改用固定秒数。'
        : outsideSlider
          ? '已保存 ' + value + ' 秒，超出滑块范围；保留原值，拖动后才修改。'
          : '拖动或使用方向键调整，每次 1 秒。';
  /** 首次键盘打开时等 portal 挂载再聚焦滑块；hover 打开不执行此步骤。 */
  const focusSlider = (container: HTMLDivElement | null) => {
    if (!container || !focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    container
      .querySelector<HTMLInputElement>('input[type="range"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  };

  /** 仅关闭时长浮层，不提交新值，也不关闭媒体参数页或完整编辑器。 */
  const close = () => {
    setOpen(false);
    setPinned(false);
    focusOnOpenRef.current = false;
  };

  return (
    <div
      className="node-parameter-select compact-select node-quick-editor-select-group"
      onKeyDown={(event) => {
        if (!open) return;
        if (isImeKeyboardEvent(event)) {
          event.stopPropagation();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
          triggerRef.current?.focus({ preventScroll: true });
        } else if (contentRef.current?.contains(event.target as Node)) {
          // 方向键、Home/End 和 Tab 交给原生滑块，不触发画布快捷键。
          event.stopPropagation();
        }
      }}
    >
      <span className="compact-select-label">时长（秒）</span>
      <Popover
        open={open}
        trigger={pinned ? ['click'] : ['hover', 'click']}
        placement="topLeft"
        mouseEnterDelay={0.1}
        mouseLeaveDelay={0.18}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true);
          else close();
        }}
        getPopupContainer={nodePopupContainer}
        classNames={{ root: 'node-quick-editor-duration-popover' }}
        styles={{ root: { pointerEvents: 'auto' } }}
        destroyOnHidden
        content={
          <div
            id={popupId}
            role="dialog"
            aria-label="视频时长"
            className="node-quick-editor-duration-card"
            ref={(container) => {
              contentRef.current = container;
              focusSlider(container);
            }}
            onFocusCapture={() => setPinned(true)}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(event.relatedTarget) &&
                event.relatedTarget !== triggerRef.current
              )
                close();
            }}
          >
            <div className="node-quick-editor-duration-heading">
              <span>视频时长</span>
              <output htmlFor={inputId} aria-live="polite">
                {selectionLabel}
              </output>
            </div>
            <Input
              type="number"
              step="any"
              aria-label="自定义时长（秒）"
              value={value}
              disabled={inputDisabled}
              onChange={(event) => onChange(event.currentTarget.value)}
            />
            <div className="node-quick-editor-duration-range">
              <input
                ref={inputRef}
                id={inputId}
                className="node-quick-editor-duration-slider"
                type="range"
                min={sliderMin}
                max={sliderMax}
                step={1}
                value={sliderValue}
                style={
                  {
                    '--duration-progress':
                      ((sliderValue - sliderMin) / (sliderMax - sliderMin)) * 100 + '%',
                  } as CSSProperties
                }
                aria-label="视频时长（秒）"
                aria-valuetext={
                  fixedDuration && !outsideSlider
                    ? selectionLabel
                    : selectionLabel + '，滑块参考起点 ' + sliderValue + ' 秒'
                }
                aria-invalid={Boolean(issue)}
                aria-describedby={[inputId + '-hint', issue ? inputId + '-issue' : undefined]
                  .filter(Boolean)
                  .join(' ')}
                disabled={inputDisabled}
                onChange={(event) => onChange(event.currentTarget.value)}
                onClick={(event) => {
                  // 历史值与滑块参考点不同，点击当前圆点也属于显式选择。
                  if (!inputDisabled && event.currentTarget.value !== value) {
                    onChange(event.currentTarget.value);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    inputDisabled ||
                    isImeKeyboardEvent(event) ||
                    (fixedDuration && !outsideSlider)
                  )
                    return;
                  // 原生 Home/End 停在参考端点时不触发 change，仍须保存用户的选择。
                  if (event.key === 'Home' || event.key === 'End') {
                    event.preventDefault();
                    onChange(String(event.key === 'Home' ? sliderMin : sliderMax));
                  }
                }}
              />
              <div className="node-quick-editor-duration-scale" aria-hidden="true">
                {[5, 10, 15, 20, 25, 30]
                  .filter((seconds, index, values) => values.indexOf(seconds) === index)
                  .map((seconds) => (
                    <span key={seconds}>{seconds}</span>
                  ))}
              </div>
            </div>
            <div className="node-quick-editor-duration-hints">
              <span>
                {sliderMin}–{sliderMax} 秒 · 新建默认 {sliderDefault} 秒
              </span>
              <small id={inputId + '-hint'}>{hint}</small>
              {issue && (
                <small
                  id={inputId + '-issue'}
                  className="node-quick-editor-duration-issue"
                  role="status"
                >
                  {issue}
                </small>
              )}
            </div>
            <div className="node-quick-editor-duration-actions">
              {
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="自动时长"
                  aria-pressed={automatic}
                  disabled={inputDisabled}
                  title="由模型根据输入决定时长"
                  onClick={() => {
                    onChange('-1');
                    close();
                    triggerRef.current?.focus({ preventScroll: true });
                  }}
                >
                  自动时长
                </Button>
              }
              <Button
                type="button"
                variant="ghost"
                disabled={inputDisabled || value === ''}
                title="删除显式时长参数，由上游处理未设置值"
                onClick={() => {
                  onChange('');
                  close();
                  triggerRef.current?.focus({ preventScroll: true });
                }}
              >
                清除时长
              </Button>
            </div>
          </div>
        }
      >
        <Button
          ref={triggerRef}
          type="button"
          className="node-quick-editor-duration-trigger"
          aria-label={'时长（秒）：' + selectionLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popupId : undefined}
          onClick={(event) => {
            // hover 后第一次点击固定卡片，再次点击才收起，避免移动过来就关掉。
            const nextOpen = !open || !pinned;
            focusOnOpenRef.current = nextOpen && event.detail === 0;
            setOpen(nextOpen);
            setPinned(nextOpen);
            if (nextOpen) focusSlider(contentRef.current);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' || isImeKeyboardEvent(event)) return;
            event.preventDefault();
            event.stopPropagation();
            focusOnOpenRef.current = true;
            setOpen(true);
            setPinned(true);
            focusSlider(contentRef.current);
          }}
        >
          <span>{selectionLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
      </Popover>
    </div>
  );
}

/**
 * 在固定图标槽中等比绘制比例；未声明固定比例的选项使用虚线方框。
 * @param ratio 菜单声明的宽高比例，例如 `16 / 9`；无效或缺失时按方形绘制。
 * @returns 纯装饰图形，不提供交互，也不修改节点参数。
 */
function AspectRatioPreview({ ratio }: { ratio?: string }) {
  const [horizontal, vertical] = (ratio ?? '1 / 1').split('/').map(Number);
  const aspect =
    Number.isFinite(horizontal) && horizontal > 0 && Number.isFinite(vertical) && vertical > 0
      ? horizontal / vertical
      : 1;
  const width = Math.min(40, 28 * aspect);
  const height = Math.min(28, 40 / aspect);
  return (
    <span className="node-quick-editor-aspect-icon" aria-hidden="true">
      <svg
        className={['node-quick-editor-aspect-preview', !ratio && 'is-default']
          .filter(Boolean)
          .join(' ')}
        viewBox="0 0 44 32"
      >
        <rect
          x={(44 - width) / 2}
          y={(32 - height) / 2}
          width={width}
          height={height}
          rx={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </span>
  );
}

/** 保留参数短枚举、模型分组和未设置语义；选项导航与焦点由 Ant Design 处理。 */
function NodeParameterSelect({
  label,
  value,
  options,
  onChange,
  className,
  disabled,
  optionLayout = 'list',
  aspectOptions = false,
  allowCustomValue = false,
}: {
  label: string;
  value?: string;
  options: QuickOption[];
  onChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  optionLayout?: 'list' | 'grid';
  aspectOptions?: boolean;
  allowCustomValue?: boolean;
}) {
  const selectId = useId();
  const [customValue, setCustomValue] = useState('');
  const selected = options.find((option) => option.value === value);
  const selectionLabel = selected
    ? [selected.label, selected.trailingLabel].filter(Boolean).join(' · ')
    : '未设置';
  const entries = options.map((option) => ({
    ...option,
    title: option.description ? option.label + ' · ' + option.description : option.label,
    'aria-label': [option.label, option.description, option.trailingLabel]
      .filter(Boolean)
      .join(' '),
  }));
  const grouped = entries.some((option) => option.groupLabel)
    ? [...new Set(entries.map((option) => option.groupLabel))].flatMap<
        NonNullable<SelectProps<string>['options']>[number]
      >((group) =>
        group
          ? [{ label: group, options: entries.filter((option) => option.groupLabel === group) }]
          : entries.filter((option) => !option.groupLabel),
      )
    : entries;
  return (
    <div
      className={[
        'node-parameter-select',
        aspectOptions ? 'node-quick-editor-option-group' : 'compact-select',
        aspectOptions && 'node-parameter-aspect-select',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="compact-select-label">{label}</span>
      <Select<string>
        id={selectId}
        aria-label={label + '：' + selectionLabel}
        value={selected?.value}
        placeholder="未设置"
        disabled={disabled || (!allowCustomValue && !options.some((option) => !option.disabled))}
        options={grouped}
        onSelect={onChange}
        virtual={false}
        styles={{
          popup: { root: { pointerEvents: 'auto', ...(aspectOptions && { minWidth: 0 }) } },
        }}
        placement="topLeft"
        getPopupContainer={nodePopupContainer}
        popupMatchSelectWidth={false}
        classNames={{
          popup: {
            root: ['node-parameter-options', aspectOptions && 'node-parameter-aspect-options']
              .filter(Boolean)
              .join(' '),
            list: optionLayout === 'grid' ? 'node-parameter-grid' : undefined,
          },
        }}
        labelRender={() =>
          aspectOptions && selected ? (
            <span className="node-parameter-aspect-selection">
              <AspectRatioPreview ratio={selected.previewAspectRatio} />
              <span>{selectionLabel}</span>
            </span>
          ) : (
            selectionLabel
          )
        }
        popupRender={(menu) => (
          <div
            ref={(container) => {
              if (!container) return;
              /** 为可能延后挂载的真实选项列表补名称，不创建替代角色或接管焦点。 */
              const labelListbox = () => {
                container
                  .querySelector('[role="listbox"]')
                  ?.setAttribute('aria-label', `${label}选项`);
              };
              const observer = new MutationObserver(labelListbox);
              observer.observe(container, { childList: true, subtree: true });
              labelListbox();
              return () => observer.disconnect();
            }}
          >
            {menu}
            {allowCustomValue && (
              <div className="node-parameter-custom-value">
                <Input
                  aria-label={'自定义' + label}
                  value={customValue}
                  placeholder="输入上游参数值"
                  onChange={(event) => setCustomValue(event.currentTarget.value)}
                  onKeyDown={(event) => event.stopPropagation()}
                />
                <Button
                  type="button"
                  disabled={!customValue.trim()}
                  onClick={() => {
                    onChange(customValue.trim());
                    setCustomValue('');
                  }}
                >
                  采用参数
                </Button>
              </div>
            )}
          </div>
        )}
        optionRender={(option) => (
          <span className="node-parameter-option">
            {aspectOptions && <AspectRatioPreview ratio={option.data.previewAspectRatio} />}
            <span className="node-quick-editor-option-copy">
              <strong>{option.data.label}</strong>
              {option.data.description && <small>{option.data.description}</small>}
            </span>
          </span>
        )}
      />
    </div>
  );
}

/** 比例沿用相同 Select 交互，同时保留可视化比例预览和供应商说明。 */
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
  return (
    <NodeParameterSelect
      label={label}
      value={normalizeCurrentOptionValue(value)}
      options={options}
      onChange={onChange}
      aspectOptions={aspectOptions}
      allowCustomValue
      optionLayout="grid"
    />
  );
}

/**
 * 新建节点或显式选择模型时补齐编辑默认值，已有参数及未知字段始终保留。
 * 目录仅提供默认选项，不依据媒体能力删改用户值；历史节点加载不调用此函数。
 */
export function applyNodeGenerationDefaults(
  data: AssetFlowNode['data'],
  model: ModelEntry | undefined,
): AssetFlowNode['data'] {
  const mediaType = data.mediaType;
  const parameters = readNodeMediaParameters(data);
  if (
    mediaType === 'video' &&
    parameters.duration === undefined &&
    parameters.seconds === undefined &&
    parameters.durationSeconds === undefined
  )
    parameters.duration = VIDEO_DURATION_RANGE.default;
  if (!model) return { ...data, parameters };
  const options = getMediaOptions(model, mediaType, {}, false, model.id);
  if (mediaType === 'image') {
    const hasStoredImageOutput =
      imageSizeParameterAliases.some((alias) => parameters[alias] !== undefined) ||
      imageQualityParameterAliases.some((alias) => parameters[alias] !== undefined) ||
      parameters.aspectRatio !== undefined ||
      parameters.aspect_ratio !== undefined;
    if (!hasStoredImageOutput) {
      const size = firstAvailableOption(options.resolution),
        quality = firstAvailableOption(options.quality);
      if (size !== undefined) parameters.size = size;
      if (quality !== undefined) parameters.quality = quality;
    }
  } else if (mediaType === 'video') {
    for (const field of ['resolution', 'aspectRatio'] as const) {
      const aliases =
        field === 'resolution'
          ? ['resolution', 'video_resolution', 'videoResolution', 'size']
          : ['aspectRatio', 'aspect_ratio', 'ratio'];
      if (aliases.some((alias) => parameters[alias] !== undefined)) continue;
      const value = firstAvailableOption(options[field]);
      if (value !== undefined) parameters[field] = value;
    }
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
 * 图片参数在新建副本中规范为官方 size 与真实 quality，旧源节点保持不变。
 * @returns 最近同类型节点的模型、凭据、参数和推理强度；没有可沿用节点时返回 undefined。
 * @throws ImageOutputParameterError 历史图片参数冲突或非法时阻止创建不确定的新副本。
 */
export function resolvePreviousOperationSeed(
  nodes: readonly AssetFlowNode[],
  mediaType: AssetFlowNode['data']['mediaType'],
  mode: Exclude<AssetFlowNode['data']['mode'], 'source'>,
):
  | Pick<AssetFlowNode['data'], 'modelAlias' | 'credentialId' | 'parameters' | 'inferenceStrength'>
  | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const data = nodes[index]?.data;
    if (!data || data.mediaType !== mediaType || data.mode !== mode) continue;
    const storedParameters = readNodeMediaParameters(data);
    const parameters =
      mediaType === 'image'
        ? (normalizeImageOutputParameters(storedParameters) as NodeMediaParameters)
        : storedParameters;
    return {
      ...(data.modelAlias ? { modelAlias: data.modelAlias } : {}),
      ...(data.credentialId ? { credentialId: data.credentialId } : {}),
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
      ...(data.inferenceStrength ? { inferenceStrength: data.inferenceStrength } : {}),
    };
  }
  return undefined;
}

/** 合并建议选项并保持首见顺序；目录禁用标记不构成 Canvas 的能力门禁。 */
function mergeOptions(...sources: readonly MediaOption[][]): MediaOption[] {
  const seen = new Set<string>();
  return sources.flatMap((source) =>
    source.flatMap(({ disabled: _disabled, ...option }) => {
      if (seen.has(option.value)) return [];
      seen.add(option.value);
      return [option];
    }),
  );
}

/** 目录提供建议，常用选项和已保存参数始终可以发送给上游。 */
function getMediaOptions(
  model: ModelEntry | undefined,
  mediaType: AssetFlowNode['data']['mediaType'],
  parameters: NodeMediaParameters,
  allowLegacyFallback = true,
  modelAlias?: string,
) {
  const roots = getCapabilityRoots(model, mediaType),
    resolvedModelAlias = modelAlias ?? model?.id;
  const declaredQuality =
    readCapabilityOptions(
      roots,
      ['quality', 'qualities', 'imageQuality', 'image_quality'],
      'quality',
    ) ?? [];
  const nativeQuality = declaredQuality.filter(
    (option) => !readImageResolutionParameter(option.value)?.resolution,
  );
  const declaredRatios =
    readCapabilityOptions(
      roots,
      ['aspectRatio', 'aspectRatios', 'aspect_ratio', 'aspect_ratios', 'ratios'],
      'aspectRatio',
    ) ?? [];
  const compatibleImageOutput =
    mediaType === 'image' ? readCompatibleImageOutputParameters(parameters) : undefined;
  const imageAspectRatioValue = imageAspectRatioForSize(compatibleImageOutput?.size);
  const imageTierAspectRatio =
    imageAspectRatioValue ?? firstAvailableOption(declaredRatios) ?? '1:1';
  const declaredSizes = readCapabilityOptions(
    roots,
    [
      'size',
      'sizes',
      'imageSize',
      'imageSizes',
      'image_size',
      'image_sizes',
      'resolution',
      'resolutions',
      'imageResolution',
      'image_resolution',
    ],
    'quality',
  );
  const sizeSource =
    declaredSizes ??
    declaredQuality.filter((option) => {
      const resolution = readImageResolutionParameter(option.value)?.resolution;
      return resolution !== undefined && resolution !== 'auto';
    });
  const declaredImageSizes = imageSizeOptions(sizeSource, imageTierAspectRatio, resolvedModelAlias);
  const fallbackImageSizes = imageSizeOptions(
    legacyImageResolutionTiers,
    imageTierAspectRatio,
    resolvedModelAlias,
  );
  const resolution =
    mediaType === 'image'
      ? ensureCurrentOption(
          mergeOptions(declaredImageSizes, allowLegacyFallback ? fallbackImageSizes : []),
          compatibleImageOutput?.size,
          'resolution',
        )
      : ensureCurrentOption(
          mergeOptions(
            readCapabilityOptions(
              roots,
              [
                'resolution',
                'resolutions',
                'videoResolution',
                'video_resolution',
                'quality',
                'qualities',
              ],
              'resolution',
            ) ?? [],
            allowLegacyFallback ? videoResolutionOptions : [],
          ),
          parameters.resolution ?? parameters.video_resolution ?? parameters.videoResolution,
          'resolution',
        );
  if (mediaType === 'image') {
    for (const option of resolution) {
      const display = formatImageSize(option.value);
      if (display) option.label = display;
    }
  }
  const aspectRatio = ensureCurrentOption(
    mergeOptions(
      declaredRatios,
      allowLegacyFallback
        ? [
            ...(mediaType === 'video' ? [adaptiveVideoAspectRatioOption] : []),
            ...aspectRatioOptions,
          ]
        : [],
    ),
    mediaType === 'image'
      ? imageAspectRatioValue
      : (parameters.aspectRatio ?? parameters.aspect_ratio ?? parameters.ratio),
    'aspectRatio',
  );
  const duration = ensureCurrentOption(
    mergeOptions(
      readCapabilityOptions(
        roots,
        ['duration', 'durations', 'seconds', 'durationSeconds', 'duration_seconds'],
        'duration',
      ) ?? [],
      allowLegacyFallback
        ? [
            automaticVideoDurationOption,
            ...[4, 8, 12, 15, 20].map((value) => ({
              value: String(value),
              label: String(value),
              description: '秒',
            })),
          ]
        : [],
    ),
    parameters.duration ?? parameters.seconds ?? parameters.durationSeconds,
    'duration',
  );
  const quality = ensureCurrentOption(
    mergeOptions(
      nativeQuality,
      allowLegacyFallback
        ? ['auto', 'low', 'medium', 'high'].map((value) => ({ value, label: value }))
        : [],
    ),
    readNativeImageQuality(parameters),
    'quality',
  );
  return {
    quality,
    videoResolutionSupported: true,
    resolution,
    aspectRatio,
    duration,
    imageResolutionValue: compatibleImageOutput?.size,
    imageAspectRatioValue,
    hasNativeImageQuality: allowLegacyFallback || Boolean(nativeQuality.length),
  };
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

/** 只展示声明支持当前节点媒体类型的模型；不改变节点已保存模型或提交校验。 */
function buildModelOptions(
  models: ModelEntry[],
  mediaType: AssetFlowNode['data']['mediaType'],
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
      description: currentCredentialId ? '已保存的分组身份' : '已保存模型',
    });
  }
  const visibleModels = models.filter((model) => model.mediaTypes.includes(mediaType));
  for (const group of groupModelsByCredential(visibleModels)) {
    for (const model of group.models) {
      options.push({
        value: modelOptionValue({
          modelAlias: model.id,
          credentialId: model.credentialId,
        }),
        label: model.name,
        trailingLabel: model.group ?? model.credentialLabel,
        groupLabel: group.label,
      });
    }
  }
  return options.length > 0 ? options : [{ value: '', label: '暂无可用模型', disabled: true }];
}

/** 按精确模型与凭据找到目录建议；目录缺失不限制节点运行。 */
function findSelectedModel(
  models: ModelEntry[],
  modelAlias: string,
  credentialId: string | undefined,
): ModelEntry | undefined {
  return (
    models.find((model) => model.id === modelAlias && model.credentialId === credentialId) ??
    (!modelAlias ? models[0] : undefined)
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

/** 将模型与凭据绑定编码为菜单可用的稳定值。 */
function modelOptionValue(selection: ModelSelection) {
  if (!selection.modelAlias) return '';
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
      typeof parsed[2] === 'string'
    )
      return { modelAlias: parsed[2] };
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
    const id = model.credentialId ?? 'unavailable';
    const group = groups.get(id) ?? {
      id,
      label: model.group ?? model.credentialLabel ?? '未知分组',
      models: [],
    };
    group.models.push(model);
    groups.set(id, group);
  }
  return [...groups.values()];
}

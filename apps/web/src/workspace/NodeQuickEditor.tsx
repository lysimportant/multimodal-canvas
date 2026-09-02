import { LoaderCircle, Play, Sparkles } from 'lucide-react';
import { useState, type FocusEvent } from 'react';

import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { CompactSelect } from './CompactSelect';
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
};

export type NodeQuickEditorProps = {
  node: AssetFlowNode;
  models: ModelEntry[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onModelChange: (value: ModelSelection) => void;
  onInferenceStrengthChange: (value: InferenceStrength) => void;
  onRun: () => void;
  /** 当前节点是否有可供转换/生成的连线输入。 */
  hasConnectedInput?: boolean;
  /** 更新节点的媒体参数；未提供时参数控件仍可显示但不会修改父状态。 */
  onParametersChange?: (value: NodeMediaParameters) => void;
};

type MediaOption = {
  value: string;
  label: string;
  description?: string;
  previewAspectRatio?: string;
  disabled?: boolean;
};

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
  models,
  busy,
  onPromptChange,
  onModelChange,
  onInferenceStrengthChange,
  onRun,
  hasConnectedInput = false,
  onParametersChange,
}: NodeQuickEditorProps) {
  const currentModel = node.data.modelAlias ?? '';
  const currentCredentialId = node.data.credentialId;
  const availableModels = models.filter((model) => model.mediaTypes.includes(node.data.mediaType));
  const selectedModel = findSelectedModel(availableModels, currentModel, currentCredentialId);
  const currentModelIsMissing =
    Boolean(currentModel) &&
    !availableModels.some(
      (model) => model.id === currentModel && model.credentialId === currentCredentialId,
    );
  const currentModelValue = currentModel
    ? modelOptionValue({ modelAlias: currentModel, credentialId: currentCredentialId })
    : '';
  const modelOptions = buildModelOptions(
    availableModels,
    currentModelValue,
    currentModel,
    currentCredentialId,
    currentModelIsMissing,
  );
  const parameters = readNodeMediaParameters(node.data);
  const mediaOptions = getMediaOptions(selectedModel, node.data.mediaType, parameters);
  const inferenceOptions = getInferenceStrengthOptions(
    selectedModel,
    node.data.mediaType,
    currentModel,
    node.data.inferenceStrength,
  );
  const enabled = node.data.enabled !== false;
  const hasPrompt = Boolean(node.data.prompt?.trim());
  const hasRunnableParameters = hasPrompt || hasConnectedInput;

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

  return (
    <section
      className="node-quick-editor nodrag nowheel nopan"
      aria-label={`${node.data.label}生成设置`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="node-quick-editor-header">
        <span className="node-quick-editor-icon" aria-hidden="true">
          <Sparkles size={16} />
        </span>
        <div className="node-quick-editor-heading">
          <span>生成设置 · {mediaLabels[node.data.mediaType]}</span>
          <strong title={node.data.label}>{node.data.label}</strong>
        </div>
      </header>

      <div className="node-quick-editor-prompt-group">
        <label className="node-quick-editor-field node-quick-editor-prompt">
          <span>提示词</span>
          <TextPromptEditor
            nodeId={node.id}
            value={node.data.prompt ?? ''}
            placeholder="描述你想生成的内容"
            onChange={onPromptChange}
          />
        </label>
      </div>

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
            openOnHover
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
        <div
          className="node-quick-editor-media-options"
          data-columns="3"
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
            openOnHover
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
            onChange={(value) => updateParameter('duration', value ? Number(value) : undefined)}
            className="node-quick-editor-select-group"
            placement="top"
            openOnHover
          />
        </div>
      )}

      <div
        className="node-quick-editor-controls"
        data-has-inference={inferenceOptions.length > 0 ? 'true' : 'false'}
      >
        <CompactSelect
          label="模型"
          value={currentModelValue}
          options={modelOptions}
          onChange={(value) => onModelChange(parseModelOptionValue(value))}
          className="node-quick-editor-select-group"
          placement="top"
          openOnHover
        />
        {inferenceOptions.length > 0 && (
          <CompactSelect
            label="推理强度"
            value={node.data.inferenceStrength}
            options={inferenceOptions}
            onChange={(value) => onInferenceStrengthChange(value)}
            className="node-quick-editor-select-group"
            placement="top"
            openOnHover
          />
        )}
        <button
          type="button"
          className="button button-primary node-quick-editor-run"
          aria-label={busy ? '生成中' : '生成'}
          title={
            busy
              ? '生成中'
              : !enabled
                ? '节点已停用'
                : !hasRunnableParameters
                  ? '请先填写提示词或连接输入节点'
                  : '生成'
          }
          onClick={onRun}
          disabled={busy || !enabled || !hasRunnableParameters}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} aria-hidden="true" />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </section>
  );
}

/** 从节点数据中读取媒体参数，并返回可独立修改的浅拷贝。 */
function readNodeMediaParameters(data: unknown): NodeMediaParameters {
  if (!data || typeof data !== 'object') return {};
  const candidate = (data as { parameters?: unknown }).parameters;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return { ...(candidate as Record<string, unknown>) };
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
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };
  let previousGroup: string | undefined;

  return (
    <div
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      data-placement="top"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        type="button"
        className="node-quick-editor-option-trigger"
        aria-label={`${label}：${formatTriggerLabel(selectedOption, hasExplicitSelection, options)}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={formatTriggerLabel(selectedOption, hasExplicitSelection, options)}>
          {formatTriggerLabel(selectedOption, hasExplicitSelection, options)}
        </span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="node-quick-editor-option-popover" role="group" aria-label={`${label}选项`}>
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
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
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

/** 返回当前模型的媒体能力，并为没有声明能力的旧目录提供回退选项。 */
function getMediaOptions(
  model: ModelEntry | undefined,
  mediaType: AssetFlowNode['data']['mediaType'],
  parameters: NodeMediaParameters,
) {
  const roots = getCapabilityRoots(model, mediaType);
  const quality = ensureCurrentOption(
    readCapabilityOptions(
      roots,
      ['quality', 'qualities', 'imageQuality', 'image_quality', 'resolution', 'resolutions'],
      'quality',
    ) ?? imageQualityOptions,
    parameters.quality,
    'quality',
  );
  const resolution = ensureCurrentOption(
    readCapabilityOptions(
      roots,
      ['resolution', 'resolutions', 'videoResolution', 'video_resolution', 'quality', 'qualities'],
      'resolution',
    ) ?? videoResolutionOptions,
    parameters.resolution,
    'resolution',
  );
  const aspectRatio = ensureCurrentOption(
    readCapabilityOptions(
      roots,
      ['aspectRatio', 'aspectRatios', 'aspect_ratio', 'aspect_ratios', 'ratios'],
      'aspectRatio',
    ) ?? aspectRatioOptions,
    parameters.aspectRatio,
    'aspectRatio',
  );
  const duration = ensureCurrentOption(
    readCapabilityOptions(
      roots,
      ['duration', 'durations', 'seconds', 'durationSeconds', 'duration_seconds'],
      'duration',
    ) ??
      [4, 8, 12, 16, 20].map((value) => ({
        value: String(value),
        label: String(value),
        description: '秒',
      })),
    parameters.duration,
    'duration',
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
        value: modelOptionValue({ modelAlias: model.id, credentialId: model.credentialId }),
        label: model.name,
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
): ModelEntry | undefined {
  return (
    models.find((model) => model.id === modelAlias && model.credentialId === credentialId) ??
    models[0]
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
      if (options.length > 0) return options;
    }
  }
  return undefined;
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
    const fallbackDescription = kind === 'aspectRatio' ? aspectRatioDescriptions[value] : undefined;
    const description =
      item.description ?? fallbackDescription ?? (kind === 'duration' ? '秒' : undefined);
    const label = item.label ?? (kind === 'quality' ? value.toUpperCase() : value);
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
    if (typeof value === 'string' || typeof value === 'number') {
      return [{ value: key, label: String(value) }];
    }
    if (
      isRecord(value) &&
      (typeof value.label === 'string' || typeof value.description === 'string')
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
  return JSON.stringify([selection.credentialId ?? '', selection.modelAlias]);
}

/** 解析模型菜单值，并兼容旧版仅含模型别名的值。 */
function parseModelOptionValue(value: string): ModelSelection {
  if (!value) return { modelAlias: '' };
  try {
    const parsed = JSON.parse(value) as unknown;
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
    const id = model.credentialId ?? 'active';
    const group = groups.get(id) ?? {
      id,
      label:
        model.credentialLabel ??
        (model.credentialId ? `API Key · ${model.credentialId.slice(0, 8)}` : '当前 API Key'),
      models: [],
    };
    group.models.push(model);
    groups.set(id, group);
  }
  return [...groups.values()];
}

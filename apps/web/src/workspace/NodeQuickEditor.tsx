import { LoaderCircle, Play, Sparkles } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';

import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { mediaLabels, type ModelEntry, type ModelSelection } from './contracts';

export type InferenceStrength = 'low' | 'medium' | 'high';

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
  /** 更新节点的媒体参数；未提供时参数控件仍可显示但不会修改父状态。 */
  onParametersChange?: (value: NodeMediaParameters) => void;
};

const inferenceStrengthOptions: Array<{
  value: InferenceStrength;
  label: string;
}> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const imageQualityOptions = [
  { value: '1k', label: '1K · 标准' },
  { value: '2k', label: '2K · 高清' },
  { value: '3k', label: '3K · 超清' },
  { value: '4k', label: '4K · 极致' },
];

const videoResolutionOptions = ['360p', '480p', '720p', '1080p', '1440p', '2160p'];

const aspectRatioOptions = [
  { value: '1:1', label: '1:1 · 方形' },
  { value: '16:9', label: '16:9 · 横屏' },
  { value: '9:16', label: '9:16 · 竖屏' },
  { value: '4:3', label: '4:3 · 标准横向' },
  { value: '3:4', label: '3:4 · 标准竖向' },
  { value: '3:2', label: '3:2 · 摄影横向' },
  { value: '2:3', label: '2:3 · 摄影竖向' },
  { value: '21:9', label: '21:9 · 超宽屏' },
];

/** 渲染选中生成节点的紧凑编辑器。 */
export function NodeQuickEditor({
  node,
  models,
  busy,
  onPromptChange,
  onModelChange,
  onInferenceStrengthChange,
  onRun,
  onParametersChange,
}: NodeQuickEditorProps) {
  const currentModel = node.data.modelAlias ?? '';
  const currentCredentialId = node.data.credentialId;
  const availableModels = models.filter((model) => model.mediaTypes.includes(node.data.mediaType));
  const currentModelIsMissing =
    Boolean(currentModel) &&
    !availableModels.some(
      (model) => model.id === currentModel && model.credentialId === currentCredentialId,
    );
  const currentValue = currentModel
    ? modelOptionValue({ modelAlias: currentModel, credentialId: currentCredentialId })
    : '';
  const groupedModels = groupModelsByCredential(availableModels);
  const enabled = node.data.enabled !== false;
  const parameters = readNodeMediaParameters(node.data);

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
          <MediaOptionGrid
            label="图片清晰度"
            value={parameters.quality}
            options={imageQualityOptions}
            onChange={(value) => updateParameter('quality', value)}
          />
          <AspectRatioOptionGrid
            label="图片比例"
            value={parameters.aspectRatio}
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
          <MediaOptionGrid
            label="视频清晰度"
            value={parameters.resolution}
            options={videoResolutionOptions.map((value) => ({ value, label: value }))}
            onChange={(value) => updateParameter('resolution', value)}
          />
          <AspectRatioOptionGrid
            label="视频比例"
            value={parameters.aspectRatio}
            onChange={(value) => updateParameter('aspectRatio', value)}
          />
          <MediaOptionGrid
            label="时长（秒）"
            value={parameters.duration?.toString()}
            options={[4, 8, 12, 16, 20].map((value) => ({
              value: String(value),
              label: `${value} 秒`,
            }))}
            onChange={(value) => updateParameter('duration', value ? Number(value) : undefined)}
          />
        </div>
      )}

      <div className="node-quick-editor-controls">
        <label className="node-quick-editor-field">
          <span>模型</span>
          <select
            value={currentValue}
            onChange={(event) => onModelChange(parseModelOptionValue(event.target.value))}
          >
            <option value="">继承项目默认模型</option>
            {currentModelIsMissing && (
              <option value={currentValue}>
                {currentModel}
                {currentCredentialId ? '（当前设置，目录中不可用）' : '（旧设置，未绑定 API Key）'}
              </option>
            )}
            {groupedModels.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.models.map((model) => (
                  <option
                    key={`${model.credentialId ?? 'active'}:${model.id}`}
                    value={modelOptionValue({
                      modelAlias: model.id,
                      credentialId: model.credentialId,
                    })}
                  >
                    {model.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="node-quick-editor-field">
          <span>推理强度</span>
          <select
            value={node.data.inferenceStrength ?? 'medium'}
            onChange={(event) => onInferenceStrengthChange(event.target.value as InferenceStrength)}
          >
            {inferenceStrengthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="button button-primary node-quick-editor-run"
        onClick={onRun}
        disabled={busy || !enabled}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
        ) : (
          <Play size={16} aria-hidden="true" />
        )}
        {busy ? '生成中' : '生成'}
      </button>
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

/** 通用媒体参数选项。 */
type MediaOption = { value: string; label: string };

/**
 * 渲染一个紧凑的媒体参数选择器。
 * 选项面板在悬停、键盘聚焦或点击时展开，避免多个参数同时撑高节点编辑器。
 */
function MediaOptionGrid({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value?: unknown;
  options: MediaOption[];
  onChange: (value: string) => void;
}) {
  const currentValue = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(false);
  const { groupRef, popoverRef, placement } = usePopoverPlacement(open, options.length + 1);
  const currentLabel =
    options.find((option) => option.value === currentValue)?.label ?? (currentValue || '默认');
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div
      ref={groupRef}
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      data-placement={placement}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        type="button"
        className="node-quick-editor-option-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={currentLabel}>{currentLabel}</span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div
        ref={popoverRef}
        className="node-quick-editor-option-popover"
        role="group"
        aria-label={`${label}选项`}
      >
        <button
          type="button"
          className={`node-quick-editor-option ${currentValue === '' ? 'is-active' : ''}`}
          aria-pressed={currentValue === ''}
          onClick={() => onChange('')}
        >
          <span className="node-quick-editor-option-copy">默认</span>
        </button>
        {options.map((option) => {
          return (
            <button
              type="button"
              key={option.value}
              className={`node-quick-editor-option ${currentValue === option.value ? 'is-active' : ''}`}
              aria-pressed={currentValue === option.value}
              onClick={() => onChange(option.value)}
              title={option.label}
            >
              <span className="node-quick-editor-option-copy">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 比例选择器在悬停、键盘聚焦或点击时展开三列示意图。 */
function AspectRatioOptionGrid({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: unknown;
  onChange: (value: string) => void;
}) {
  const currentValue = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(false);
  const currentLabel =
    aspectRatioOptions.find((option) => option.value === currentValue)?.label ??
    (currentValue || '自动比例');
  const { groupRef, popoverRef, placement } = usePopoverPlacement(
    open,
    aspectRatioOptions.length + 1,
  );
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div
      ref={groupRef}
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      data-placement={placement}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        type="button"
        className="node-quick-editor-option-trigger"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={currentLabel}>{currentLabel}</span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div
        ref={popoverRef}
        className="node-quick-editor-option-popover"
        role="group"
        aria-label={`${label}选项`}
      >
        <button
          type="button"
          className={`node-quick-editor-option node-quick-editor-aspect-option ${currentValue === '' ? 'is-active' : ''}`}
          aria-pressed={currentValue === ''}
          onClick={() => onChange('')}
        >
          <span className="node-quick-editor-aspect-preview is-default" aria-hidden="true" />
          <span className="node-quick-editor-option-copy">自动比例</span>
        </button>
        {aspectRatioOptions.map((option) => (
          <button
            type="button"
            key={option.value}
            className={`node-quick-editor-option node-quick-editor-aspect-option ${currentValue === option.value ? 'is-active' : ''}`}
            aria-pressed={currentValue === option.value}
            onClick={() => onChange(option.value)}
            title={option.label}
          >
            <span
              className="node-quick-editor-aspect-preview"
              style={{ aspectRatio: option.value.replace(':', ' / ') }}
              aria-hidden="true"
            />
            <span className="node-quick-editor-option-copy">
              <strong>{option.value}</strong>
              <small>{option.label.replace(`${option.value} · `, '')}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 根据参数组在画布中的可用空间选择浮层方向。
 * 浮层超出画布底部时向上展开，滚动画布或窗口尺寸变化后会重新测量。
 * @param open 当前参数面板是否展开。
 * @param optionCount 面板中的选项总数，用于首次测量的高度估算。
 * @returns 参数组、浮层引用与最终展开方向。
 */
function usePopoverPlacement(open: boolean, optionCount: number) {
  const groupRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');
  const updatePlacement = useCallback(() => {
    const group = groupRef.current;
    const popover = popoverRef.current;
    if (!group || !popover) return;

    const groupRect = group.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const canvasRect =
      group.closest<HTMLElement>('.canvas-area')?.getBoundingClientRect() ??
      document
        .querySelector<HTMLElement>('.canvas-area.has-quick-editor, .canvas-area')
        ?.getBoundingClientRect();
    const topBoundary = canvasRect?.top ?? 0;
    const bottomBoundary = canvasRect?.bottom ?? window.innerHeight;
    const availableAbove = Math.max(0, groupRect.top - topBoundary - 6);
    const availableBelow = Math.max(0, bottomBoundary - groupRect.bottom - 6);
    const estimatedHeight = Math.min(
      320,
      Math.ceil(optionCount / 3) * (optionCount > 7 ? 78 : 56) + 17,
    );
    const popoverHeight = popoverRect.height || estimatedHeight;
    const nextPlacement =
      availableBelow >= popoverHeight || availableBelow >= availableAbove ? 'bottom' : 'top';
    setPlacement((current) => (current === nextPlacement ? current : nextPlacement));
  }, [optionCount]);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement('bottom');
      return;
    }
    updatePlacement();
    const handleViewportChange = () => updatePlacement();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open, updatePlacement]);

  return { groupRef, popoverRef, placement };
}

/** 将模型与凭据绑定编码为原生 select 可用的稳定值。 */
function modelOptionValue(selection: ModelSelection) {
  if (!selection.modelAlias) return '';
  return JSON.stringify([selection.credentialId ?? '', selection.modelAlias]);
}

/** 解析模型 select 的值，并兼容旧版仅含模型别名的选项。 */
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
    // Keep legacy plain option values usable in tests and restored markup.
  }
  return { modelAlias: value };
}

/** 按凭据分组模型，供原生 select 渲染 optgroup。 */
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

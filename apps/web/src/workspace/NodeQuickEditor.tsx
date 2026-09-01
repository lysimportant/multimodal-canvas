import { LoaderCircle, Play, Sparkles, WandSparkles } from 'lucide-react';
import { useState, type FocusEvent } from 'react';

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
  /** 请求父层使用当前提示词生成优化版本。 */
  onOptimizePrompt?: () => void;
  /** 父层正在请求提示词优化结果。 */
  optimizingPrompt?: boolean;
};

const inferenceStrengthOptions: Array<{
  value: InferenceStrength;
  label: string;
}> = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const imageSizeOptions = [
  { value: '1024x1024', label: '1024 × 1024 · 方形' },
  { value: '1536x1024', label: '1536 × 1024 · 横向' },
  { value: '1024x1536', label: '1024 × 1536 · 竖向' },
  { value: '1792x1024', label: '1792 × 1024 · 宽幅' },
  { value: '1024x1792', label: '1024 × 1792 · 长幅' },
  { value: '2048x2048', label: '2048 × 2048 · 高清方形' },
  { value: '2048x1152', label: '2048 × 1152 · 高清横向' },
  { value: '1152x2048', label: '1152 × 2048 · 高清竖向' },
];

const imageQualityOptions = [
  { value: '1k', label: '1K · 标准' },
  { value: '2k', label: '2K · 高清' },
  { value: '3k', label: '3K · 超清' },
  { value: '4k', label: '4K · 极致' },
];

const videoSizeOptions = [
  { value: '1280x720', label: '1280 × 720 · 横向' },
  { value: '1920x1080', label: '1920 × 1080 · 全高清' },
  { value: '1080x1920', label: '1080 × 1920 · 竖向' },
  { value: '2560x1440', label: '2560 × 1440 · 2K' },
  { value: '3840x2160', label: '3840 × 2160 · 4K' },
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

export function NodeQuickEditor({
  node,
  models,
  busy,
  onPromptChange,
  onModelChange,
  onInferenceStrengthChange,
  onRun,
  onParametersChange,
  onOptimizePrompt,
  optimizingPrompt = false,
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
        {onOptimizePrompt && (
          <button
            type="button"
            className="button button-secondary"
            onClick={onOptimizePrompt}
            disabled={busy || optimizingPrompt || !enabled || !(node.data.prompt ?? '').trim()}
          >
            {optimizingPrompt ? (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            ) : (
              <WandSparkles size={15} aria-hidden="true" />
            )}
            {optimizingPrompt ? '优化中' : '优化提示词'}
          </button>
        )}
      </div>

      {node.data.mediaType === 'image' && (
        <div className="node-quick-editor-media-options" role="group" aria-label="媒体参数">
          <MediaOptionGrid
            label="图片尺寸"
            value={parameters.size}
            options={imageSizeOptions}
            onChange={(value) => updateParameter('size', value)}
            preview="size"
          />
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
        <div className="node-quick-editor-media-options" role="group" aria-label="媒体参数">
          <MediaOptionGrid
            label="视频尺寸"
            value={parameters.size}
            options={videoSizeOptions}
            onChange={(value) => updateParameter('size', value)}
            preview="size"
          />
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

function readNodeMediaParameters(data: unknown): NodeMediaParameters {
  if (!data || typeof data !== 'object') return {};
  const candidate = (data as { parameters?: unknown }).parameters;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
  return { ...(candidate as Record<string, unknown>) };
}

type MediaOption = { value: string; label: string };

/**
 * 渲染一个紧凑的媒体参数选择器。
 * 选项面板只在悬停或键盘聚焦时展开，避免多个参数同时撑高节点编辑器。
 */
function MediaOptionGrid({
  label,
  value,
  options,
  onChange,
  preview,
}: {
  label: string;
  value?: unknown;
  options: MediaOption[];
  onChange: (value: string) => void;
  preview?: 'size';
}) {
  const currentValue = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(false);
  const currentLabel =
    options.find((option) => option.value === currentValue)?.label ?? (currentValue || '默认');
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        type="button"
        className="node-quick-editor-option-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={currentLabel}>{currentLabel}</span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="node-quick-editor-option-popover" role="listbox" aria-label={`${label}选项`}>
        <button
          type="button"
          className={`node-quick-editor-option ${preview === 'size' ? 'node-quick-editor-size-option' : ''} ${currentValue === '' ? 'is-active' : ''}`}
          aria-pressed={currentValue === ''}
          onClick={() => onChange('')}
        >
          {preview === 'size' ? (
            <span className="node-quick-editor-size-preview is-default" />
          ) : null}
          <span className="node-quick-editor-option-copy">默认</span>
        </button>
        {options.map((option) => {
          const size = preview === 'size' ? parseSize(option.value) : undefined;
          return (
            <button
              type="button"
              key={option.value}
              className={`node-quick-editor-option ${preview === 'size' ? 'node-quick-editor-size-option' : ''} ${currentValue === option.value ? 'is-active' : ''}`}
              aria-pressed={currentValue === option.value}
              onClick={() => onChange(option.value)}
              title={option.label}
            >
              {size ? (
                <span
                  className="node-quick-editor-size-preview"
                  style={{ aspectRatio: `${size.width} / ${size.height}` }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="node-quick-editor-option-copy">
                <strong>{option.label}</strong>
                {size ? (
                  <small>
                    {size.width} × {size.height} 像素
                  </small>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 比例选择器在悬停或键盘聚焦时展开纵向示意图列表。 */
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
    (currentValue || '跟随尺寸');
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div
      className="node-quick-editor-option-group"
      aria-label={label}
      data-open={open ? 'true' : 'false'}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={handleBlur}
    >
      <span className="node-quick-editor-option-label">{label}</span>
      <button
        type="button"
        className="node-quick-editor-option-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span title={currentLabel}>{currentLabel}</span>
        <span className="node-quick-editor-option-trigger-icon" aria-hidden="true">
          ▾
        </span>
      </button>
      <div className="node-quick-editor-option-popover" role="listbox" aria-label={`${label}选项`}>
        <button
          type="button"
          className={`node-quick-editor-option node-quick-editor-aspect-option ${currentValue === '' ? 'is-active' : ''}`}
          aria-pressed={currentValue === ''}
          onClick={() => onChange('')}
        >
          <span className="node-quick-editor-aspect-preview is-default" aria-hidden="true" />
          <span className="node-quick-editor-option-copy">跟随尺寸</span>
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

/** 将尺寸值解析为示意图需要的宽高。 */
function parseSize(value: string): { width: number; height: number } | undefined {
  const match = value.match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function modelOptionValue(selection: ModelSelection) {
  if (!selection.modelAlias) return '';
  return JSON.stringify([selection.credentialId ?? '', selection.modelAlias]);
}

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

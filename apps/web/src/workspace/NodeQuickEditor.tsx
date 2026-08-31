import { LoaderCircle, Play, Sparkles, WandSparkles } from 'lucide-react';

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
        <>
          <MediaDimensionPreview
            mediaType="image"
            size={parameters.size}
            aspectRatio={parameters.aspectRatio}
          />
          <div className="node-quick-editor-controls" aria-label="图片参数">
            <label className="node-quick-editor-field">
              <span>图片尺寸</span>
              <select
                aria-label="图片尺寸"
                value={parameters.size ?? ''}
                onChange={(event) => updateParameter('size', event.target.value)}
              >
                <option value="">默认尺寸</option>
                {imageSizeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="node-quick-editor-field">
              <span>图片清晰度</span>
              <select
                aria-label="图片清晰度"
                value={parameters.quality ?? ''}
                onChange={(event) => updateParameter('quality', event.target.value)}
              >
                <option value="">默认清晰度</option>
                {imageQualityOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="node-quick-editor-field">
            <span>图片比例</span>
            <select
              aria-label="图片比例"
              value={parameters.aspectRatio ?? ''}
              onChange={(event) => updateParameter('aspectRatio', event.target.value)}
            >
              <option value="">跟随尺寸</option>
              {aspectRatioOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}

      {node.data.mediaType === 'video' && (
        <>
          <MediaDimensionPreview
            mediaType="video"
            size={parameters.size}
            aspectRatio={parameters.aspectRatio}
          />
          <div className="node-quick-editor-controls" aria-label="视频参数">
            <label className="node-quick-editor-field">
              <span>视频尺寸</span>
              <select
                aria-label="视频尺寸"
                value={parameters.size ?? ''}
                onChange={(event) => updateParameter('size', event.target.value)}
              >
                <option value="">默认尺寸</option>
                {videoSizeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="node-quick-editor-field">
              <span>视频清晰度</span>
              <select
                aria-label="视频清晰度"
                value={parameters.resolution ?? ''}
                onChange={(event) => updateParameter('resolution', event.target.value)}
              >
                <option value="">默认清晰度</option>
                {videoResolutionOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="node-quick-editor-controls">
            <label className="node-quick-editor-field">
              <span>视频比例</span>
              <select
                aria-label="视频比例"
                value={parameters.aspectRatio ?? ''}
                onChange={(event) => updateParameter('aspectRatio', event.target.value)}
              >
                <option value="">跟随尺寸</option>
                {aspectRatioOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="node-quick-editor-field">
              <span>时长（秒）</span>
              <select
                aria-label="视频时长（秒）"
                value={parameters.duration?.toString() ?? ''}
                onChange={(event) => {
                  const value = event.target.value;
                  updateParameter('duration', value ? Number(value) : undefined);
                }}
              >
                <option value="">默认时长</option>
                <option value="4">4 秒</option>
                <option value="8">8 秒</option>
                <option value="12">12 秒</option>
                <option value="16">16 秒</option>
                <option value="20">20 秒</option>
              </select>
            </label>
          </div>
        </>
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

/**
 * 展示当前尺寸和比例的几何预览，让横竖屏差异在选择前后都可见。
 * @param mediaType 当前节点媒体类型。
 * @param size 当前尺寸值，例如 `1920x1080`。
 * @param aspectRatio 用户指定的比例；未指定时从尺寸推导。
 */
function MediaDimensionPreview({
  mediaType,
  size,
  aspectRatio,
}: {
  mediaType: 'image' | 'video';
  size?: unknown;
  aspectRatio?: unknown;
}) {
  const sizeValue = typeof size === 'string' && size.trim() ? size.trim() : undefined;
  const explicitRatio = normalizeAspectRatio(aspectRatio);
  const ratio =
    explicitRatio ?? ratioFromSize(sizeValue) ?? (mediaType === 'video' ? '16:9' : '1:1');
  const sizeLabel = sizeValue ?? '默认尺寸';
  const mediaLabel = mediaType === 'image' ? '图片' : '视频';

  return (
    <div
      className="node-quick-editor-dimension-preview"
      aria-label={`${mediaLabel}尺寸示意图：${sizeLabel}，比例 ${ratio}`}
    >
      <div className="node-quick-editor-dimension-stage" aria-hidden="true">
        <div
          className="node-quick-editor-dimension-frame"
          style={{ aspectRatio: ratio.replace(':', ' / ') }}
        >
          <span>{ratio}</span>
        </div>
      </div>
      <div className="node-quick-editor-dimension-caption">
        <strong>{sizeLabel}</strong>
        <span>
          {mediaLabel} · {ratio}
        </span>
      </div>
    </div>
  );
}

function normalizeAspectRatio(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) return undefined;
  return `${Number(match[1])}:${Number(match[2])}`;
}

function ratioFromSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  const match = size.match(/^(\d+)x(\d+)$/i);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return undefined;
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
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

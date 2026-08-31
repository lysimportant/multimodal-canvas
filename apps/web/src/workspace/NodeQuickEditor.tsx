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
        <div className="node-quick-editor-controls" aria-label="图片参数">
          <label className="node-quick-editor-field">
            <span>图片尺寸</span>
            <select
              aria-label="图片尺寸"
              value={parameters.size ?? ''}
              onChange={(event) => updateParameter('size', event.target.value)}
            >
              <option value="">默认尺寸</option>
              <option value="1024x1024">1024 × 1024</option>
              <option value="1536x1024">1536 × 1024</option>
              <option value="1024x1536">1024 × 1536</option>
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
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
      )}

      {node.data.mediaType === 'video' && (
        <div className="node-quick-editor-controls" aria-label="视频参数">
          <label className="node-quick-editor-field">
            <span>视频尺寸</span>
            <select
              aria-label="视频尺寸"
              value={parameters.resolution ?? ''}
              onChange={(event) => updateParameter('resolution', event.target.value)}
            >
              <option value="">默认尺寸</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </label>
          <label className="node-quick-editor-field">
            <span>视频清晰度</span>
            <select
              aria-label="视频清晰度"
              value={parameters.quality ?? ''}
              onChange={(event) => updateParameter('quality', event.target.value)}
            >
              <option value="">默认清晰度</option>
              <option value="standard">标准</option>
              <option value="high">高</option>
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
            </select>
          </label>
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

import { LoaderCircle, Play, Sparkles } from 'lucide-react';

import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { mediaLabels, type ModelEntry } from './contracts';

export type InferenceStrength = 'low' | 'medium' | 'high';

export type NodeQuickEditorProps = {
  node: AssetFlowNode;
  models: ModelEntry[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onInferenceStrengthChange: (value: InferenceStrength) => void;
  onRun: () => void;
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
}: NodeQuickEditorProps) {
  const currentModel = node.data.modelAlias ?? '';
  const availableModels = models.filter((model) => model.mediaTypes.includes(node.data.mediaType));
  const currentModelIsMissing =
    Boolean(currentModel) && !availableModels.some((model) => model.id === currentModel);
  const enabled = node.data.enabled !== false;

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

      <label className="node-quick-editor-field node-quick-editor-prompt">
        <span>提示词</span>
        <TextPromptEditor
          nodeId={node.id}
          value={node.data.prompt ?? ''}
          placeholder="描述你想生成的内容"
          onChange={onPromptChange}
        />
      </label>

      <div className="node-quick-editor-controls">
        <label className="node-quick-editor-field">
          <span>模型</span>
          <select value={currentModel} onChange={(event) => onModelChange(event.target.value)}>
            <option value="">继承项目默认模型</option>
            {currentModelIsMissing && (
              <option value={currentModel}>{currentModel}（当前设置，目录中不可用）</option>
            )}
            {availableModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
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

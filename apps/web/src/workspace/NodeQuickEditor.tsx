import { LoaderCircle, Play, Sparkles } from 'lucide-react';

import type { AssetFlowNode } from '../canvas-utils';
import { TextPromptEditor } from '../TextPromptEditor';
import { mediaLabels, type ModelEntry, type ModelSelection } from './contracts';

export type InferenceStrength = 'low' | 'medium' | 'high';

export type NodeQuickEditorProps = {
  node: AssetFlowNode;
  models: ModelEntry[];
  busy: boolean;
  onPromptChange: (value: string) => void;
  onModelChange: (value: ModelSelection) => void;
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

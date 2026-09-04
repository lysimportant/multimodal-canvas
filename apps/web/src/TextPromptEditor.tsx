import type { Asset, PromptDocument, PromptMention } from '@multimodal-canvas/domain';

import { ResourceMentionEditor } from './ResourceMentionEditor';

type TextPromptEditorProps = {
  nodeId: string;
  value: string;
  placeholder?: string;
  /** 旧纯文本回调；传入 `onDocumentChange` 时由结构化回调优先。 */
  onChange?: (value: string) => void;
  /** 结构化提示词文档；存在时优先于旧纯文本字段。 */
  promptDocument?: PromptDocument;
  /** 当前项目资源，用于 `@` 搜索和提及卡片。 */
  assets?: readonly Asset[];
  /** 结构化文档保存回调。 */
  onDocumentChange?: (document: PromptDocument) => void;
  /** 查看提及资源详情的可选回调。 */
  onMentionDetails?: (mention: PromptMention, asset: Asset | undefined) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

/**
 * 提示词编辑器的兼容入口。
 *
 * 旧调用方继续使用 `value`/`onChange`；新调用方传入 `promptDocument`、
 * `assets` 和 `onDocumentChange` 后即可获得通用资源提及能力。具体交互由
 * ResourceMentionEditor 统一实现，确保快速编辑器和检查器使用同一套逻辑。
 */
export function TextPromptEditor({
  nodeId,
  value,
  placeholder = '输入提示词',
  onChange,
  promptDocument,
  assets,
  onDocumentChange,
  onMentionDetails,
  ariaLabel,
  disabled,
  className,
}: TextPromptEditorProps) {
  return (
    <ResourceMentionEditor
      nodeId={nodeId}
      value={value}
      promptDocument={promptDocument}
      assets={assets}
      // 结构化文档是唯一执行来源；避免新编辑同时触发两个父层更新。
      onChange={onDocumentChange ? undefined : onChange}
      onDocumentChange={onDocumentChange}
      onMentionDetails={onMentionDetails}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      disabled={disabled}
      className={className}
    />
  );
}

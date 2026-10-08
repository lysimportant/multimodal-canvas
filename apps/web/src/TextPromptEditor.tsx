import type { ProjectResourceSearch } from './project-resource-search';
import type {
  Asset,
  NodeResourceRef,
  PromptDocument,
  PromptMention,
} from '@multimodal-canvas/domain';
import { useMemo } from 'react';

import { ResourceMentionEditor } from './ResourceMentionEditor';
import { projectConnectedPromptDocument } from './resource-mention-sync';
import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';

/** 共享提示词入口参数；资源顺序与参考资料选择状态由父层持久化和控制。 */
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
  connectedAssets?: readonly ConnectedPromptAsset[];
  /** 画布是否正在为当前节点连续添加参考资料。 */
  referencePickActive?: boolean;
  /** 切换参考资料选择模式；缺省时不显示入口。 */
  onReferencePickToggle?: () => void;
  /** 资源条优先顺序，按资产与冻结版本匹配，不改变正文顺序。 */
  resourceRefs?: readonly NodeResourceRef[];
  /** 按当前项目在服务端分页搜索；未提供时兼容使用传入的完整目录。 */
  onSearchProjectResources?: ProjectResourceSearch;
  /** 回传完整资源条顺序；保存失败可同步抛错，由编辑器显示原始错误。 */
  onResourceReorder?: (resources: readonly { assetId: string; assetVersion?: number }[]) => void;
  /** 一次移除资源连线及引用，文档保留全部可见文字。 */
  onResourceRemove?: (
    resource: { assetId: string; assetVersion?: number },
    document: PromptDocument,
  ) => void;
  /** 父层原子保存连线别名和正文引用，不重命名源资源。 */
  onConnectedResourceRename?: (assetId: string, name: string, assetVersion?: number) => void;
  /** 结构化文档保存回调。 */
  onDocumentChange?: (document: PromptDocument) => void;
  /** 提示词资源条点击上传后，把本地文件收成项目资源。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 上传完成只添加独立资料，不把资源原子或名称写入正文。 */
  onResourceAttach?: (asset: Asset) => void;
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
  connectedAssets,
  referencePickActive,
  onReferencePickToggle,
  resourceRefs,
  onSearchProjectResources,
  onResourceReorder,
  onResourceRemove,
  onConnectedResourceRename,
  onDocumentChange,
  onUploadResource,
  onResourceAttach,
  onMentionDetails,
  ariaLabel,
  disabled,
  className,
}: TextPromptEditorProps) {
  /** 父层重建连线数组或等值文档时保留投影 ID，不重置输入草稿。 */
  const projectionKey = JSON.stringify([
    nodeId,
    promptDocument ?? value,
    connectedAssets?.map((asset) => [
      asset.id,
      asset.name,
      asset.mediaType,
      asset.referenceName,
      asset.assetVersion,
      asset.referenceNeedsSync,
      asset.versionUnavailable,
    ]),
  ]);
  const projection = useMemo(() => {
    try {
      return {
        document: projectConnectedPromptDocument(
          { prompt: value, promptDocument },
          connectedAssets ?? [],
        ),
      };
    } catch (error) {
      return {
        document: promptDocument,
        error: error instanceof Error ? error.message : '引用恢复失败，请检查来源和别名',
      };
    }
  }, [projectionKey]);
  return (
    <>
      <ResourceMentionEditor
        nodeId={nodeId}
        value={value}
        promptDocument={projection.document}
        assets={assets}
        onSearchProjectResources={onSearchProjectResources}
        connectedAssets={connectedAssets}
        referencePickActive={referencePickActive}
        onReferencePickToggle={onReferencePickToggle}
        resourceRefs={resourceRefs}
        onResourceReorder={onResourceReorder}
        onResourceRemove={onResourceRemove}
        onConnectedResourceRename={onConnectedResourceRename}
        // 结构化文档是唯一执行来源；避免新编辑同时触发两个父层更新。
        onChange={onDocumentChange ? undefined : onChange}
        onDocumentChange={onDocumentChange}
        onUploadResource={onUploadResource}
        onResourceAttach={onResourceAttach}
        onMentionDetails={onMentionDetails}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        disabled={disabled}
        className={className}
      />
      {projection.error && (
        <p role="alert" className="resource-mention-edit-warning">
          引用未自动恢复：{projection.error}
        </p>
      )}
    </>
  );
}

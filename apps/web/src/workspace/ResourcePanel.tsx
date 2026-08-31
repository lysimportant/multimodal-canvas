import {
  Archive,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquarePlus,
  Upload,
  X,
} from 'lucide-react';
import { useRef, type DragEvent, type RefObject } from 'react';

import type { Asset } from '@multimodal-canvas/domain';
import { useImeDraft } from '../ime';
import { AssetPreview } from './AssetPreview';
import { formatBytes, mediaLabels, type AssetFilter } from './contracts';

export function ResourcePanel({
  assets,
  collapsed,
  showArchived,
  activeFilter,
  query,
  isUploading,
  uploadProgress,
  onToggleArchived,
  onFilterChange,
  onQueryChange,
  onFilesSelected,
  onAssetDragStart,
  onAddAsset,
  onRenameAsset,
  onArchiveAsset,
  onDrop,
  onToggleCollapsed,
  uploadInputRef,
}: {
  assets: Asset[];
  collapsed: boolean;
  showArchived: boolean;
  activeFilter: AssetFilter;
  query: string;
  isUploading: boolean;
  uploadProgress: number | null;
  onToggleArchived: () => void;
  onFilterChange: (filter: AssetFilter) => void;
  onQueryChange: (query: string) => void;
  onFilesSelected: (files: FileList | File[]) => void;
  onAssetDragStart: (event: DragEvent, asset: Asset) => void;
  onAddAsset: (asset: Asset) => void;
  onRenameAsset: (asset: Asset) => void;
  onArchiveAsset: (asset: Asset) => void;
  onDrop: (event: DragEvent) => void;
  onToggleCollapsed: () => void;
  uploadInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = uploadInputRef ?? localInputRef;
  const { bind: queryBinding } = useImeDraft<HTMLInputElement>({
    value: query,
    onCommit: onQueryChange,
  });
  const filteredAssets = assets.filter((asset) => {
    if (showArchived !== (asset.status === 'archived')) return false;
    const matchesFilter = activeFilter === 'all' || asset.mediaType === activeFilter;
    return matchesFilter && asset.name.toLowerCase().includes(query.toLowerCase());
  });
  const visibleAssets = assets.filter((asset) =>
    showArchived ? asset.status === 'archived' : asset.status !== 'archived',
  );
  return (
    <aside
      className={`resource-panel ${collapsed ? 'is-collapsed' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">资源库</p>
          <h1>项目资源</h1>
        </div>
        <button
          type="button"
          className="icon-button resource-upload-button"
          aria-label="上传资源"
          title="上传资源"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}
        </button>
        <button
          type="button"
          className="icon-button resource-collapse-button"
          aria-label={collapsed ? '展开资源栏' : '折叠资源栏'}
          title={collapsed ? '展开资源栏' : '折叠资源栏'}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/*,audio/*,video/*,text/*,.md,.json"
          multiple
          onChange={(event) => {
            if (event.target.files) onFilesSelected(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      {!collapsed && (
        <label className="resource-filter-field">
          <span>资源类型</span>
          <select
            aria-label="资源类型"
            value={activeFilter}
            onChange={(event) => onFilterChange(event.target.value as AssetFilter)}
          >
            <option value="all">全部资源（{visibleAssets.length}）</option>
            {(Object.keys(mediaLabels) as Array<Exclude<AssetFilter, 'all'>>).map((mediaType) => (
              <option key={mediaType} value={mediaType}>
                {mediaLabels[mediaType]}（
                {
                  assets.filter(
                    (asset) =>
                      (showArchived ? asset.status === 'archived' : asset.status !== 'archived') &&
                      asset.mediaType === mediaType,
                  ).length
                }
                ）
              </option>
            ))}
          </select>
        </label>
      )}
      {!collapsed && (
        <label className="search-field">
          <Search size={15} aria-hidden="true" />
          <input type="search" placeholder="搜索资源" {...queryBinding} />
          {queryBinding.value && (
            <button
              type="button"
              className="clear-search"
              aria-label="清除搜索"
              onClick={() => onQueryChange('')}
            >
              <X size={14} />
            </button>
          )}
        </label>
      )}
      {!collapsed && (
        <button
          type="button"
          className={`archive-filter ${showArchived ? 'is-active' : ''}`}
          onClick={onToggleArchived}
        >
          <Archive size={13} aria-hidden="true" />
          {showArchived ? '查看可用资源' : '查看已归档资源'}
        </button>
      )}
      {!collapsed && isUploading && uploadProgress !== null && (
        <div className="upload-progress" role="status">
          <div className="upload-progress-label">
            <span>上传中</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="upload-progress-track">
            <span style={{ width: `${uploadProgress}%` }} />
          </div>
        </div>
      )}
      {!collapsed && (
        <div className="asset-list" aria-live="polite">
          {filteredAssets.map((asset) => (
            <article
              className={`asset-card ${asset.status === 'archived' ? 'is-archived' : ''}`}
              draggable={asset.status !== 'archived'}
              key={asset.id}
              onDragStart={(event) => onAssetDragStart(event, asset)}
              title={asset.status === 'archived' ? '已归档资源' : '拖入画布创建来源节点'}
            >
              <AssetPreview asset={asset} className="asset-card-preview" />
              <div className="asset-card-copy">
                <strong title={asset.name}>{asset.name}</strong>
                <span>
                  {mediaLabels[asset.mediaType]} · {formatBytes(asset.sizeBytes)}
                </span>
              </div>
              <div className="asset-card-actions">
                <button
                  type="button"
                  className="asset-add-button"
                  aria-label={
                    asset.status === 'archived' ? `恢复 ${asset.name}` : `添加 ${asset.name} 到画布`
                  }
                  title={asset.status === 'archived' ? '恢复资源' : '添加到画布'}
                  onClick={() =>
                    asset.status === 'archived' ? onArchiveAsset(asset) : onAddAsset(asset)
                  }
                >
                  {asset.status === 'archived' ? <RotateCcw size={15} /> : <SquarePlus size={16} />}
                </button>
                <button
                  type="button"
                  className="asset-add-button"
                  aria-label={`重命名 ${asset.name}`}
                  title="重命名"
                  onClick={() => onRenameAsset(asset)}
                >
                  <Pencil size={14} />
                </button>
              </div>
            </article>
          ))}
          {filteredAssets.length === 0 && (
            <div className="empty-panel compact-empty">
              <Upload size={22} aria-hidden="true" />
              <strong>{assets.length === 0 ? '还没有资源' : '没有匹配资源'}</strong>
              <p>
                {assets.length === 0
                  ? '点击右上角上传，或将文件拖到这里。'
                  : '尝试调整搜索或筛选条件。'}
              </p>
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

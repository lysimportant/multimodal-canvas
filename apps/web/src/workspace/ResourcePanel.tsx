import { Button, Input } from '@multimodal-canvas/ui';
import { Modal, Select } from 'antd';
import {
  LoaderCircle,
  History,
  ChevronDown,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SquarePlus,
  Upload,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import type { Asset } from '@multimodal-canvas/domain';
import { useImeDraft } from '../ime';
import { AssetPreview, AssetViewerDialog } from './AssetPreview';
import { AssetGenerationHistory } from './AssetGenerationHistory';
import { formatBytes, mediaLabels, type AssetFilter } from './contracts';
import './CompactSelect.css';
import './ResourcePanel.css';

/**
 * 项目资源抽屉：保留工具和搜索区域，悬停或聚焦时临时展开，点击箭头固定/收起。
 * 仅显式固定操作通知父级保存偏好；弹层交互期间保持展开，拖出资源时保留拖拽源 DOM。
 * 拖到提示词仍用于引用；放入画布请用添加按钮。
 */
export function ResourcePanel({
  assets,
  collapsed,
  isRenameDialogOpen = false,
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
  onDeleteAsset,
  onDrop,
  onToggleCollapsed,
  uploadInputRef,
}: {
  assets: Asset[];
  /** true 表示自动收起，false 表示固定展开；临时悬停/焦点不修改此值。 */
  collapsed: boolean;
  /** 父级重命名弹窗打开时保留资源列表与返回焦点，不因 portal 移出而收起。 */
  isRenameDialogOpen?: boolean;
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
  onDeleteAsset?: (asset: Asset) => void;
  onDrop: (event: DragEvent) => void;
  onToggleCollapsed: () => void;
  uploadInputRef?: RefObject<HTMLInputElement | null>;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const localInputRef = useRef<HTMLInputElement>(null);
  const inputRef = uploadInputRef ?? localInputRef;
  const [modal, modalContextHolder] = Modal.useModal();
  /** 当前正在预览的资源；关闭对话框后清空。 */
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  /** 版本历史独立于原节点，资源保留时仍可读取生成说明。 */
  const [historyAsset, setHistoryAsset] = useState<Asset | null>(null);
  /** 刚结束 HTML5 拖拽时忽略随后的 click，避免误开预览。 */
  const draggedRef = useRef(false);
  const dragResetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pointerInside, setPointerInside] = useState(false);
  const [focusInside, setFocusInside] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const previousCollapsedRef = useRef(collapsed);
  const [draggingOutside, setDraggingOutside] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const dialogOpen = Boolean(
    previewAsset || historyAsset || confirmationOpen || isRenameDialogOpen,
  );
  const expanded =
    !draggingOutside &&
    (!collapsed || dialogOpen || filterOpen || (!dismissed && (pointerInside || focusInside)));

  /** 判断事件目标是否在实际抽屉内；不把挂载到 body 的预览/确认弹窗当作悬停。 */
  const isPanelTarget = (target: EventTarget | null) =>
    target instanceof Node && Boolean(panelRef.current?.contains(target));

  /** 显式收起压过当前悬停/焦点，直到重新进入；焦点留在始终可见的箭头按钮。 */
  const dismissDrawer = () => {
    setDismissed(true);
    setPointerInside(false);
    setFocusInside(false);
    if (!collapsed) onToggleCollapsed();
    collapseButtonRef.current?.focus();
  };

  useEffect(() => {
    if (collapsed && !previousCollapsedRef.current) setDismissed(true);
    previousCollapsedRef.current = collapsed;
  }, [collapsed]);

  useEffect(() => () => clearTimeout(dragResetTimerRef.current), []);

  useEffect(() => {
    if (!collapsed || dialogOpen) return;
    /** 画布可能阻止默认聚焦；点击抽屉外仍结束编辑焦点，不影响内部 Select 的 portal。 */
    const dismissOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      setPointerInside(false);
      setFocusInside(false);
      setDismissed(true);
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && panelRef.current?.contains(focused)) focused.blur();
    };
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointer, true);
  }, [collapsed, dialogOpen]);

  useEffect(() => {
    if (!collapsed || !expanded || dialogOpen || filterOpen) return;
    /** 纯悬停不转移焦点；仅收起未被画布或输入法消费的 Escape，不抢外部焦点。 */
    const dismissHoverOnEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.isComposing ||
        event.defaultPrevented ||
        (event.target instanceof Node && panelRef.current?.contains(event.target))
      )
        return;
      setPointerInside(false);
      setFocusInside(false);
      setDismissed(true);
    };
    document.addEventListener('keydown', dismissHoverOnEscape);
    return () => document.removeEventListener('keydown', dismissHoverOnEscape);
  }, [collapsed, expanded, dialogOpen, filterOpen]);

  /**
   * 打开资源预览；拖拽结束后的残留 click 会被忽略。
   * @param asset 被点击的资源卡片。
   */
  const openPreview = (asset: Asset) => {
    if (draggedRef.current) return;
    setPreviewAsset(asset);
  };

  /**
   * 键盘激活卡片预览，避免把操作按钮也当成预览热区。
   * @param event 键盘事件。
   * @param asset 当前卡片资源。
   */
  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLElement>, asset: Asset) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openPreview(asset);
  };
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
  const resourceOptions = [
    { value: 'all', label: `全部资源（${visibleAssets.length}）` },
    ...(Object.keys(mediaLabels) as Array<Exclude<AssetFilter, 'all'>>).map((mediaType) => ({
      value: mediaType,
      label: `${mediaLabels[mediaType]}（${
        assets.filter(
          (asset) =>
            (showArchived ? asset.status === 'archived' : asset.status !== 'archived') &&
            asset.mediaType === mediaType,
        ).length
      }）`,
    })),
  ];
  return (
    <aside
      ref={panelRef}
      aria-label="项目资源"
      className={`resource-panel resource-drawer ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      onMouseOver={(event) => {
        if (!isPanelTarget(event.target)) return;
        if (!isPanelTarget(event.relatedTarget) && !draggedRef.current) {
          setPointerInside(true);
          setDismissed(false);
        }
      }}
      onMouseOut={(event) => {
        if (isPanelTarget(event.target) && !isPanelTarget(event.relatedTarget)) {
          setPointerInside(false);
        }
      }}
      onFocusCapture={(event) => {
        if (!isPanelTarget(event.target)) return;
        setFocusInside(true);
        if (event.target !== collapseButtonRef.current) setDismissed(false);
      }}
      onBlurCapture={(event) => {
        if (!isPanelTarget(event.relatedTarget)) setFocusInside(false);
      }}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.nativeEvent.isComposing &&
          !event.defaultPrevented &&
          !filterOpen &&
          !dialogOpen
        ) {
          event.preventDefault();
          event.stopPropagation();
          dismissDrawer();
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!draggedRef.current || isPanelTarget(event.relatedTarget)) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX >= bounds.left &&
          event.clientX < bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY < bounds.bottom
        )
          return;
        setDraggingOutside(true);
        setPointerInside(false);
        setFocusInside(false);
        setDismissed(true);
      }}
      onDrop={onDrop}
    >
      <div className="panel-heading resource-panel-heading">
        <div
          className="compact-select resource-filter-field"
          data-open={filterOpen ? 'true' : 'false'}
          data-placement="bottom"
        >
          <Select<AssetFilter>
            id={`resource-filter-${listId}`}
            aria-label="资源类型"
            className="compact-select-antd"
            size="small"
            value={activeFilter}
            options={resourceOptions}
            open={filterOpen}
            onOpenChange={setFilterOpen}
            onChange={onFilterChange}
            virtual={false}
            showSearch={false}
            placement="bottomLeft"
            getPopupContainer={() => panelRef.current ?? document.body}
            classNames={{ popup: { root: 'compact-select-antd-popup' } }}
            styles={{ popup: { root: { minWidth: 180, pointerEvents: 'auto' } } }}
          />
        </div>
        <Button
          type="button"
          className="icon-button resource-upload-button"
          aria-label="上传资源"
          title="上传资源"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? <LoaderCircle className="spin" size={17} /> : <Plus size={18} />}
        </Button>
        <Button
          type="button"
          className={`icon-button archive-filter-icon ${showArchived ? 'is-active' : ''}`}
          aria-label={showArchived ? '查看可用资源' : '查看已归档资源'}
          title={showArchived ? '查看可用资源' : '查看已归档资源'}
          onClick={onToggleArchived}
        >
          <Trash2 size={18} aria-hidden="true" />
        </Button>
        <Button
          ref={collapseButtonRef}
          type="button"
          className="icon-button resource-collapse-button"
          aria-label={collapsed ? '展开资源栏' : '折叠资源栏'}
          title={collapsed ? '点击固定展开，悬停或聚焦可临时展开' : '收起资源栏'}
          aria-expanded={expanded}
          aria-pressed={!collapsed}
          aria-controls={listId}
          onClick={() => {
            if (collapsed) {
              setDismissed(false);
              onToggleCollapsed();
            } else {
              dismissDrawer();
            }
          }}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
        <input
          ref={inputRef}
          className="visually-hidden"
          tabIndex={-1}
          type="file"
          accept="image/*,audio/*,video/*,text/*,.md,.json"
          multiple
          onChange={(event) => {
            if (event.target.files) onFilesSelected(event.target.files);
            event.target.value = '';
          }}
        />
      </div>
      <label className="search-field">
        <Search size={15} aria-hidden="true" />
        <Input type="search" placeholder="搜索资源" {...queryBinding} />
        {queryBinding.value && (
          <Button
            type="button"
            className="clear-search"
            aria-label="清除搜索"
            onClick={() => onQueryChange('')}
          >
            <X size={14} />
          </Button>
        )}
      </label>
      {isUploading && uploadProgress !== null && (
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
      <div
        id={listId}
        className="asset-list"
        role="region"
        aria-label="资源列表"
        aria-live="polite"
        aria-hidden={!expanded}
        inert={!expanded}
      >
        {filteredAssets.map((asset) => (
          <article
            className={`asset-card ${asset.status === 'archived' ? 'is-archived' : ''}`}
            draggable={asset.status !== 'archived'}
            key={asset.id}
            onDragStart={(event) => {
              clearTimeout(dragResetTimerRef.current);
              draggedRef.current = true;
              setDraggingOutside(false);
              onAssetDragStart(event, asset);
            }}
            onDragEnd={(event) => {
              // 原生拖拽可能没有外部 mouseout；以落点清除残留悬停，不依赖 dragleave 的旧坐标。
              const bounds = panelRef.current?.getBoundingClientRect();
              if (
                bounds &&
                (event.clientX < bounds.left ||
                  event.clientX >= bounds.right ||
                  event.clientY < bounds.top ||
                  event.clientY >= bounds.bottom)
              ) {
                setPointerInside(false);
                setFocusInside(false);
                setDismissed(true);
              }
              setDraggingOutside(false);
              clearTimeout(dragResetTimerRef.current);
              dragResetTimerRef.current = setTimeout(() => {
                draggedRef.current = false;
              }, 50);
            }}
            title={
              asset.status === 'archived'
                ? '已归档资源'
                : '拖到提示词中引用，使用添加按钮放入画布。点击预览。'
            }
          >
            <div
              className="asset-card-hit"
              role="button"
              tabIndex={0}
              aria-label={`预览 ${asset.name}`}
              onClick={() => openPreview(asset)}
              onKeyDown={(event) => handlePreviewKeyDown(event, asset)}
            >
              <AssetPreview asset={asset} className="asset-card-preview" />
              <div className="asset-card-copy">
                <strong title={asset.name}>{asset.name}</strong>
                <span>
                  {mediaLabels[asset.mediaType]} · {formatBytes(asset.sizeBytes)}
                </span>
              </div>
            </div>
            <div className="asset-card-actions">
              <Button
                type="button"
                id={`asset-history-${asset.id}`}
                className="asset-add-button"
                aria-label={`生成记录 ${asset.name}`}
                title="生成记录"
                onClick={() => setHistoryAsset(asset)}
              >
                <History size={14} />
              </Button>
              <Button
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
              </Button>
              {asset.status === 'archived' && (
                <Button
                  type="button"
                  className="asset-add-button asset-delete-button"
                  aria-label={`永久删除 ${asset.name}`}
                  title="永久删除资源，删除后无法找回"
                  onClick={() => {
                    setConfirmationOpen(true);
                    modal.confirm({
                      title: '永久删除资源',
                      afterClose: () => setConfirmationOpen(false),
                      content: `资源“${asset.name}”将被永久删除，删除后无法找回。确定继续吗？`,
                      okText: '永久删除',
                      cancelText: '取消',
                      okButtonProps: { danger: true },
                      focusable: { autoFocusButton: 'cancel' },
                      onOk: () => onDeleteAsset?.(asset),
                    });
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              )}
              <Button
                type="button"
                className="asset-add-button"
                aria-label={`重命名 ${asset.name}`}
                title="重命名"
                onClick={() => onRenameAsset(asset)}
              >
                <Pencil size={14} />
              </Button>
              {asset.status !== 'archived' && (
                <Button
                  type="button"
                  className="asset-add-button asset-archive-button"
                  aria-label={`删除 ${asset.name}`}
                  title="删除资源（归档）"
                  onClick={() => {
                    setConfirmationOpen(true);
                    modal.confirm({
                      title: '归档资源',
                      afterClose: () => setConfirmationOpen(false),
                      content: `将“${asset.name}”移入已归档？可在已归档列表恢复。`,
                      okText: '移入已归档',
                      cancelText: '取消',
                      focusable: { autoFocusButton: 'cancel' },
                      onOk: () => onArchiveAsset(asset),
                    });
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              )}
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
      {modalContextHolder}
      {previewAsset ? (
        <AssetViewerDialog
          asset={previewAsset}
          open
          onOpenChange={(open) => {
            if (!open) setPreviewAsset(null);
          }}
        />
      ) : null}
      {historyAsset ? (
        <AssetGenerationHistory
          key={historyAsset.id}
          asset={historyAsset}
          onClose={() => setHistoryAsset(null)}
        />
      ) : null}
    </aside>
  );
}

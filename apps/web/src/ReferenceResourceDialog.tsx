import { useEffect, useMemo, useState } from 'react';
import { Search, Upload, X } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@multimodal-canvas/ui';
import type { Asset } from '@multimodal-canvas/domain';
import type { ProjectResourceSearch, ProjectResourceSearchPage } from './project-resource-search';
import { AssetPreview } from './workspace/AssetPreview';
import { mediaLabels } from './workspace/contracts';
import { resultAssetContentUrl } from './workspace/node-echo-text';
import './ReferenceResourceDialog.css';

/** 资料窗口只查询项目目录，上传与附加资料仍由编辑器和父层保存。 */
type ReferenceResourceDialogProps = {
  /** 当前节点身份；切换后不能展示或选取旧节点请求的结果。 */
  nodeId: string;
  /** 未提供远程查询时，调用方传入的完整项目目录。 */
  assets: readonly Asset[];
  /** 已绑定当前项目和认证会话的分页查询；失败不回退为本地缓存。 */
  onSearchProjectResources?: ProjectResourceSearch;
  /** 成功上传后刷新目录，不改变当前正文或搜索词。 */
  uploadRevision: number;
  uploading: boolean;
  uploadError: string | null;
  /** 请求打开本地文件选择器；未配置上传时保留禁用按钮。 */
  onUploadRequest?: () => void;
  /** 本地添加一项明确版本的独立资料；画布持久化由父层处理，同步失败保留窗口和原因。 */
  onSelect: (asset: Asset) => void;
  /** 关闭后卸载窗口，取消目录请求并让迟到结果失效。 */
  onClose: () => void;
};

/** 本地完整目录沿用项目查询的每页 50 条合同。 */
const PAGE_SIZE = 50;

/** 优先读取明确的 latestVersion，兼容旧目录 metadata.version；未知版本不能附加。 */
function resourceVersion(asset: Asset): number | undefined {
  const value = asset.latestVersion ?? asset.metadata?.version;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 卡片预览固定到目录明确版本，仅改写可确认的应用内无版本内容地址。 */
function previewAsset(asset: Asset): Asset {
  const version = resourceVersion(asset);
  return version !== undefined && asset.contentUrl === resultAssetContentUrl(asset.id)
    ? { ...asset, contentUrl: resultAssetContentUrl(asset.id, version) }
    : asset;
}

/**
 * 从完整项目目录选择独立参考资料；正文插入仍只由显式 @ 操作完成。
 * @param props 项目目录、分页查询与父层保存回调，不调用生成接口。
 * @returns 两列资料卡片和本地上传入口；加载、分页及错误保留在窗口内。
 * @remarks 关闭、搜索、页码及查询来源变化会取消旧请求；未知版本不能静默采用最新版。
 */
export function ReferenceResourceDialog({
  nodeId,
  assets,
  onSearchProjectResources,
  uploadRevision,
  uploading,
  uploadError,
  onUploadRequest,
  onSelect,
  onClose,
}: ReferenceResourceDialogProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [response, setResponse] = useState<{
    key: string;
    source: ProjectResourceSearch;
    result?: ProjectResourceSearchPage;
    error?: string;
  } | null>(null);
  const requestKey = JSON.stringify([nodeId, query.trim(), page, revision, uploadRevision]);
  const currentResponse =
    response?.key === requestKey && response.source === onSearchProjectResources ? response : null;

  useEffect(() => {
    if (!onSearchProjectResources) return;
    const source = onSearchProjectResources;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          source({ query: query.trim(), mediaType: 'all', page, signal: controller.signal }),
        )
        .then(
          (result) => {
            if (!controller.signal.aborted) setResponse({ key: requestKey, source, result });
          },
          (error: unknown) => {
            if (!controller.signal.aborted)
              setResponse({
                key: requestKey,
                source,
                error: error instanceof Error ? error.message : '项目资料读取失败',
              });
          },
        );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [onSearchProjectResources, requestKey, query, page]);

  const localAssets = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return assets.filter((asset) => {
      const aliases = asset.metadata?.aliases;
      const searchable = [
        asset.name,
        ...asset.tags,
        typeof asset.metadata?.alias === 'string' ? asset.metadata.alias : '',
        ...(Array.isArray(aliases) ? aliases.filter((value) => typeof value === 'string') : []),
      ];
      return (
        asset.status === 'ready' &&
        !asset.archivedAt &&
        searchable.some((value) => value.toLocaleLowerCase().includes(keyword))
      );
    });
  }, [assets, query]);
  const resources = onSearchProjectResources
    ? (currentResponse?.result?.assets ?? []).filter(
        (asset) => asset.status === 'ready' && !asset.archivedAt,
      )
    : localAssets.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const total = onSearchProjectResources
    ? (currentResponse?.result?.total ?? 0)
    : localAssets.length;
  const pageSize = currentResponse?.result?.pageSize ?? PAGE_SIZE;
  const loading = Boolean(onSearchProjectResources && !currentResponse);

  // 仅根据有效目录的总数修正页码；远程越界空页须重查，不能拿加载态或错误推断空项目。
  useEffect(() => {
    if (onSearchProjectResources && !currentResponse?.result) return;
    const lastPage = Math.max(1, Math.ceil(total / pageSize));
    if (page > lastPage) setPage(lastPage);
  }, [onSearchProjectResources, currentResponse?.result, total, pageSize, page]);

  /** 本地添加成功后关闭；失败保留当前页，不写入父层未接受的资料卡片。 */
  function selectResource(asset: Asset) {
    if (uploading || resourceVersion(asset) === undefined) return;
    try {
      onSelect(asset);
      onClose();
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : '参考资料保存失败');
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="reference-resource-dialog nodrag nopan nowheel">
        <header className="reference-resource-dialog-header">
          <DialogTitle>选择参考资料</DialogTitle>
          <div>
            <Button
              type="button"
              disabled={!onUploadRequest || uploading}
              onClick={onUploadRequest}
            >
              <Upload size={15} aria-hidden="true" />
              上传本地文件
            </Button>
            <Button type="button" aria-label="关闭参考资料选择" onClick={onClose}>
              <X size={17} aria-hidden="true" />
            </Button>
          </div>
        </header>
        <label className="reference-resource-dialog-search">
          <Search size={16} aria-hidden="true" />
          <Input
            type="search"
            aria-label="搜索项目资料"
            placeholder="搜索名称、别名或标签"
            value={query}
            maxLength={512}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setPage(1);
              setSelectionError(null);
            }}
          />
        </label>
        {(selectionError || uploadError) && (
          <p className="reference-resource-dialog-error" role="alert">
            {selectionError ?? uploadError}
          </p>
        )}
        <div className="reference-resource-dialog-body" aria-busy={loading || uploading}>
          {currentResponse?.error ? (
            <div className="reference-resource-dialog-status">
              <p role="alert">{currentResponse.error}</p>
              <Button type="button" onClick={() => setRevision((current) => current + 1)}>
                重试读取项目资料
              </Button>
            </div>
          ) : loading ? (
            <p className="reference-resource-dialog-status" role="status">
              正在读取项目资料…
            </p>
          ) : resources.length === 0 ? (
            <p className="reference-resource-dialog-status" role="status">
              {query.trim() ? '没有匹配的项目资料' : '当前项目暂无可用资料'}
            </p>
          ) : (
            <ul className="reference-resource-dialog-grid" aria-label="项目参考资料">
              {resources.map((asset) => {
                const version = resourceVersion(asset);
                return (
                  <li key={asset.id} className="reference-resource-dialog-card">
                    <div className="reference-resource-dialog-preview">
                      <AssetPreview
                        asset={previewAsset(asset)}
                        mode="compact"
                        thumbnail
                        allowOpen={false}
                      />
                    </div>
                    <Button
                      type="button"
                      aria-label={`添加参考资料 ${asset.name} ${version === undefined ? '版本未确认' : `v${version}`}`}
                      disabled={version === undefined || uploading}
                      onClick={() => selectResource(asset)}
                    >
                      <span>{asset.name}</span>
                      <small>
                        {mediaLabels[asset.mediaType]} ·{' '}
                        {version === undefined ? '版本未确认' : `v${version}`}
                      </small>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {uploading && (
          <p className="reference-resource-dialog-status" role="status">
            正在上传资料…
          </p>
        )}
        {!loading && !currentResponse?.error && total > pageSize && (
          <nav className="reference-resource-dialog-pagination" aria-label="项目资料分页">
            <Button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((current) => current - 1)}
            >
              上一页项目资料
            </Button>
            <span>
              第 {page} / {Math.ceil(total / pageSize)} 页 · 共 {total} 项
            </span>
            <Button
              type="button"
              disabled={page * pageSize >= total}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页项目资料
            </Button>
          </nav>
        )}
      </DialogContent>
    </Dialog>
  );
}

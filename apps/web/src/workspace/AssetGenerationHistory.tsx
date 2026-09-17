import { useEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import type { Asset } from '@multimodal-canvas/domain';
import { apiFetch } from '../auth-client';
import { fetchAssetVersions, type AssetVersionSummary } from '../result-versions';
import { fetchAssetRequestPrompt, saveRequestPromptSummary } from '../request-prompts';
import { API_BASE_URL } from './contracts';
import { AssetViewerDialog } from './AssetPreview';
import { RequestPromptDialog, type RequestPromptDialogState } from './RequestPromptDialog';

/**
 * 资源版本历史入口；删除原节点后仍按资产权限查询说明、摘要和耗时。
 * @param asset 当前用户可见的资源，默认读取最新不可变版本。
 * @param onClose 关闭历史窗口并回到资源入口。
 * @returns 可切换版本、编辑摘要和预览内容的弹窗；加载失败显示重试，切换版本取消旧查询。
 */
export function AssetGenerationHistory({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const [versions, setVersions] = useState<AssetVersionSummary[]>([]);
  const [version, setVersion] = useState<number>();
  const [state, setState] = useState<RequestPromptDialogState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchAssetVersions(asset.id, API_BASE_URL, apiFetch)
      .then((records) => {
        if (!active) return;
        setVersions(records);
        setVersion((current) => current ?? records.at(-1)?.version);
        if (!records.length) setState({ status: 'missing' });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            status: 'failed',
            message: error instanceof Error ? error.message : '版本加载失败',
          });
      });
    return () => {
      active = false;
    };
  }, [asset.id, retry]);

  useEffect(() => {
    if (!version) return;
    const controller = new AbortController();
    setState({ status: 'loading' });
    void fetchAssetRequestPrompt(asset.id, version, API_BASE_URL, apiFetch, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setState(
          result.record
            ? {
                status: 'ready',
                record: result.record,
                recordId: result.recordId,
                timing: result.timing,
              }
            : result.inputSnapshot
              ? { status: 'input', historical: true, text: result.inputSnapshot.text }
              : { status: 'missing' },
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: 'failed',
            message: error instanceof Error ? error.message : '生成说明加载失败',
          });
      });
    return () => controller.abort();
  }, [asset.id, version, retry]);

  const selected = versions.find((entry) => entry.version === version);
  return (
    <>
      <RequestPromptDialog
        state={state}
        open={!previewOpen}
        triggerId={`asset-history-${asset.id}`}
        onClose={onClose}
        onRetry={() => setRetry((current) => current + 1)}
        versionActions={
          <div className="request-prompt-block-head">
            <label>
              结果版本{' '}
              <select
                aria-label="结果版本"
                value={version ?? ''}
                onChange={(event) => setVersion(Number(event.target.value))}
              >
                {versions.map((entry) => (
                  <option key={entry.id} value={entry.version}>
                    v{entry.version}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="预览此版本"
              title="预览此版本"
              disabled={!selected}
              onClick={() => setPreviewOpen(true)}
            >
              <Eye size={16} />
            </button>
          </div>
        }
        onSaveSummary={
          state.status === 'ready' && state.recordId && version
            ? async (summary) => {
                const savedState = state;
                const record = await saveRequestPromptSummary(
                  asset.id,
                  version,
                  savedState.recordId!,
                  summary,
                  API_BASE_URL,
                );
                setState((current) =>
                  current === savedState ? { ...savedState, record } : current,
                );
              }
            : undefined
        }
      />
      {previewOpen && selected ? (
        <AssetViewerDialog
          asset={{ ...asset, contentUrl: selected.contentUrl, sizeBytes: selected.sizeBytes }}
          open
          onOpenChange={setPreviewOpen}
        />
      ) : null}
    </>
  );
}

import { ExternalLink, X } from 'lucide-react';

import type { Asset, RunRecord } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { FailureDiagnostics } from '../FailureDiagnostics';
import { AssetPreview, AuthenticatedAssetLink, TextResultContent } from './AssetPreview';
import type { RunResultState } from './useRunResultState';

export function RunPanel({
  node,
  run,
  resultState,
  busy,
  onCancel,
  onRetry,
}: {
  node: AssetFlowNode;
  run?: RunRecord;
  resultState: RunResultState;
  busy: boolean;
  onCancel: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  const {
    resultAsset,
    versions,
    versionsLoading,
    versionsError,
    currentVersion,
    currentContentUrl,
    currentPreviewAsset,
  } = resultState;

  return (
    <>
      <div className="inspector-run-actions">
        {run && !['succeeded', 'failed', 'cancelled'].includes(run.status) && (
          <button type="button" className="button button-secondary" onClick={() => void onCancel()}>
            <X size={14} />
            取消运行
          </button>
        )}
      </div>
      <FailureDiagnostics run={run} onRetry={() => onRetry()} busy={busy} />
      {run?.result && (
        <section className="inspector-result" aria-label="运行结果">
          <div className="inspector-result-heading">
            <span className="inspector-type">运行结果</span>
            <span className="inspector-result-version">版本 {currentVersion}</span>
          </div>
          {currentContentUrl ? (
            <div className="inspector-result-link">
              {node.data.mediaType === 'text' ? (
                <div className="inspector-result-preview inspector-result-text-wrap">
                  <TextResultContent url={currentContentUrl} />
                </div>
              ) : (
                <AssetPreview
                  asset={currentPreviewAsset}
                  className="inspector-result-preview"
                  interactive
                />
              )}
              <AuthenticatedAssetLink asset={currentPreviewAsset} className="inspector-result-open">
                <span>打开结果</span>
                <ExternalLink size={13} aria-hidden="true" />
              </AuthenticatedAssetLink>
            </div>
          ) : (
            <p className="inspector-result-pending">结果已归档，内容链接待刷新。</p>
          )}
          {versionsLoading && (
            <p className="inspector-result-pending" aria-live="polite">
              正在加载结果版本…
            </p>
          )}
          {versionsError && (
            <p className="inspector-result-pending" aria-live="polite">
              版本列表加载失败：{versionsError}，仍显示当前结果。
            </p>
          )}
          {!versionsLoading && !versionsError && versions.length > 0 && (
            <div className="inspector-result-version-list" aria-label="结果版本列表">
              <span className="inspector-result-version-list-label">归档版本</span>
              <ul>
                {versions.map((version) => {
                  const isCurrent = version.version === currentVersion;
                  const versionAsset: Asset = {
                    id: version.assetId,
                    name: `${node.data.label}结果 v${version.version}`,
                    mediaType: node.data.mediaType,
                    mimeType:
                      resultAsset?.mimeType ?? node.data.mimeType ?? 'application/octet-stream',
                    sizeBytes: version.sizeBytes,
                    status: 'ready',
                    contentUrl: version.contentUrl,
                    tags: [],
                  };
                  return (
                    <li key={version.id}>
                      <AuthenticatedAssetLink asset={versionAsset} current={isCurrent}>
                        版本 {version.version}
                      </AuthenticatedAssetLink>
                      {isCurrent ? <span>（当前）</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="inspector-result-summary">{run.result.summary}</p>
        </section>
      )}
    </>
  );
}

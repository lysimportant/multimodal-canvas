import type { NodeTiming, RequestPromptRecord } from '@multimodal-canvas/domain';
import { renderRequestPromptText, requestPromptRecordKey } from '@multimodal-canvas/domain';
import { Dialog, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { Check, Copy, Loader2, Pencil, Plus, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { NodeDurationBadge, useSharedNodeClock } from './NodeDurationBadge';
import './request-prompt-editor.css';

/** 复制动作的短暂反馈状态。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** Dialog 的加载与失败状态；记录缺失与失败都要让用户看得懂。 */
export type RequestPromptDialogState =
  | { status: 'loading' }
  | { status: 'ready'; record: RequestPromptRecord; recordId?: string; timing?: NodeTiming }
  | { status: 'missing' }
  | { status: 'input'; text: string; historical: boolean }
  | { status: 'failed'; message?: string };

type RequestPromptDialogProps = {
  state: RequestPromptDialogState;
  /** 版本预览打开时暂时隐藏弹层，组件仍保留未保存的摘要草稿。 */
  open?: boolean;
  /** 触发按钮的可读名称，用于关闭后回焦。 */
  triggerId?: string;
  onClose: () => void;
  /** 加载失败时的重试入口；缺省表示不可重试。 */
  onRetry?: () => void;
  /** 保存摘要后由调用方更新 state；失败应抛错以保留编辑内容并支持重试。 */
  onSaveSummary?: (summary: string) => Promise<void>;
  /** 资产版本选择及预览入口；由资源历史面板提供。 */
  versionActions?: ReactNode;
};

/** 摘要建议长度上限，超出时给出提示但不截断真实内容。 */
const SUMMARY_MAX_CHARS = 80;

/**
 * 生成提示词只读 Dialog。
 *
 * 标题保持短，第一块是可复制的整体摘要，第二块是完整提示词；正文独立滚动，
 * 长词与长 URL 自动换行，不改变节点外壳尺寸。真实请求文本始终只读，修改摘要
 * 不会改写它。
 */
export function RequestPromptDialog({
  state,
  open = true,
  triggerId,
  onClose,
  onRetry,
  onSaveSummary,
  versionActions,
}: RequestPromptDialogProps) {
  const [summaryCopy, setSummaryCopy] = useState<CopyState>('idle');
  const [promptCopy, setPromptCopy] = useState<CopyState>('idle');
  const [editingSummary, setEditingSummary] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [savingSummary, setSavingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState<string>();
  const record = state.status === 'ready' ? state.record : undefined;
  const recordKey = record ? requestPromptRecordKey(record) : undefined;
  const activeRecordKey = useRef(recordKey);
  activeRecordKey.current = recordKey;
  const timing = state.status === 'ready' ? state.timing : undefined;
  const durationNow = useSharedNodeClock(false);

  useEffect(() => {
    setEditingSummary(false);
    setSavingSummary(false);
    setSummaryError(undefined);
    setSummaryCopy('idle');
    setPromptCopy('idle');
  }, [recordKey]);

  const copy = async (text: string, setState: (state: CopyState) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // 剪贴板失败不谎报成功：保留可选中文本并显示错误。
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1600);
  };

  const fullPrompt = record ? renderRequestPromptText(record) : '';
  const summary = record?.summary ?? '';

  /** 保存仅修改摘要；失败保留草稿，切换记录后的迟到响应不关闭新的编辑器。 */
  const saveSummary = async () => {
    if (!onSaveSummary || savingSummary) return;
    const savedRecordKey = recordKey;
    setSavingSummary(true);
    setSummaryError(undefined);
    try {
      await onSaveSummary(summaryDraft);
      if (activeRecordKey.current === savedRecordKey) setEditingSummary(false);
    } catch (error) {
      if (activeRecordKey.current === savedRecordKey) {
        setSummaryError(error instanceof Error ? error.message : '摘要保存失败');
      }
    } finally {
      if (activeRecordKey.current === savedRecordKey) setSavingSummary(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="request-prompt-dialog"
        overlayClassName="request-prompt-backdrop"
        aria-label="生成提示词"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          const trigger = triggerId ? document.getElementById(triggerId) : null;
          if (trigger) {
            event.preventDefault();
            trigger.focus();
          }
        }}
      >
        <header className="request-prompt-header">
          <DialogTitle>生成提示词</DialogTitle>
          <button
            type="button"
            className="request-prompt-close"
            aria-label="关闭生成提示词"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="request-prompt-body">
          {versionActions}
          {state.status === 'loading' ? (
            <p className="request-prompt-status" role="status">
              <Loader2 size={14} aria-hidden="true" /> 正在读取生成说明…
            </p>
          ) : null}
          {state.status === 'failed' ? (
            <div className="request-prompt-status" role="alert">
              <span>{state.message ?? '生成说明加载失败'}</span>
              {onRetry ? (
                <button type="button" className="request-prompt-retry" onClick={onRetry}>
                  <RefreshCw size={13} aria-hidden="true" /> 重试
                </button>
              ) : null}
            </div>
          ) : null}
          {state.status === 'missing' ? (
            <p className="request-prompt-status" role="status">
              未记录生成提示词。
            </p>
          ) : null}
          {state.status === 'input' ? (
            <section className="request-prompt-block">
              <h3>{state.historical ? '历史输入快照，未记录最终请求' : '当前提示词，尚未生成'}</h3>
              <pre className="request-prompt-text">{state.text}</pre>
            </section>
          ) : null}
          {record ? (
            <>
              <section className="request-prompt-block" aria-label="整体摘要">
                <div className="request-prompt-block-head">
                  <h3>整体摘要</h3>
                  <div className="request-prompt-summary-actions">
                    {onSaveSummary && !editingSummary ? (
                      <button
                        type="button"
                        className="request-prompt-copy request-prompt-icon-action"
                        aria-label={summary ? '编辑摘要' : '添加摘要'}
                        title={summary ? '编辑摘要' : '添加摘要'}
                        onClick={() => {
                          setSummaryDraft(summary);
                          setSummaryError(undefined);
                          setEditingSummary(true);
                        }}
                      >
                        {summary ? (
                          <Pencil size={13} aria-hidden="true" />
                        ) : (
                          <Plus size={13} aria-hidden="true" />
                        )}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="request-prompt-copy"
                      aria-label="复制摘要"
                      disabled={summary.length === 0}
                      onClick={() => void copy(summary, setSummaryCopy)}
                    >
                      {summaryCopy === 'copied' ? (
                        <Check size={13} aria-hidden="true" />
                      ) : (
                        <Copy size={13} aria-hidden="true" />
                      )}
                      {summaryCopy === 'copied'
                        ? '已复制'
                        : summaryCopy === 'failed'
                          ? '复制失败'
                          : '复制'}
                    </button>
                  </div>
                </div>
                {editingSummary ? (
                  <form
                    className="request-prompt-summary-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSummary();
                    }}
                  >
                    <textarea
                      aria-label="摘要正文"
                      className="request-prompt-summary-input"
                      value={summaryDraft}
                      maxLength={2_000}
                      rows={4}
                      disabled={savingSummary}
                      autoFocus
                      onChange={(event) => setSummaryDraft(event.currentTarget.value)}
                    />
                    <div className="request-prompt-summary-editor-footer">
                      <span className="request-prompt-hint">{summaryDraft.length} / 2000</span>
                      <div className="request-prompt-summary-actions">
                        <button
                          type="button"
                          className="request-prompt-copy"
                          disabled={savingSummary}
                          onClick={() => setEditingSummary(false)}
                        >
                          <X size={13} aria-hidden="true" /> 取消
                        </button>
                        <button
                          type="submit"
                          className="request-prompt-copy"
                          disabled={savingSummary}
                        >
                          {savingSummary ? (
                            <Loader2 size={13} aria-hidden="true" />
                          ) : (
                            <Save size={13} aria-hidden="true" />
                          )}
                          {savingSummary ? '保存中' : '保存摘要'}
                        </button>
                      </div>
                    </div>
                    {summaryError ? (
                      <p className="request-prompt-summary-error" role="alert">
                        {summaryError}
                      </p>
                    ) : null}
                  </form>
                ) : summary ? (
                  <p className="request-prompt-summary">{summary}</p>
                ) : (
                  <p className="request-prompt-summary is-empty">尚未记录摘要。</p>
                )}
                {summary.length > SUMMARY_MAX_CHARS ? (
                  <small className="request-prompt-hint">
                    摘要较长，完整信息请查看下方提示词。
                  </small>
                ) : null}
              </section>
              <section className="request-prompt-block" aria-label="完整提示词">
                <div className="request-prompt-block-head">
                  <h3>完整提示词</h3>
                  <button
                    type="button"
                    className="request-prompt-copy"
                    aria-label="复制完整提示词"
                    onClick={() => void copy(fullPrompt, setPromptCopy)}
                  >
                    {promptCopy === 'copied' ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Copy size={13} aria-hidden="true" />
                    )}
                    {promptCopy === 'copied'
                      ? '已复制'
                      : promptCopy === 'failed'
                        ? '复制失败'
                        : '复制完整提示词'}
                  </button>
                </div>
                <pre className="request-prompt-text">{fullPrompt}</pre>
              </section>
              <dl className="request-prompt-meta">
                <div>
                  <dt>模型</dt>
                  <dd>{record.modelAlias}</dd>
                </div>
                <div>
                  <dt>生成时间</dt>
                  <dd>{new Date(record.createdAt).toLocaleString('zh-CN')}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>
                    <NodeDurationBadge {...(timing ? { timing } : {})} now={durationNow} />
                  </dd>
                </div>
                <div>
                  <dt>结果版本</dt>
                  <dd>
                    {record.assetId
                      ? `${record.assetId}${record.assetVersion ? ` · v${record.assetVersion}` : ''}`
                      : '未关联结果'}
                  </dd>
                </div>
                {record.negativeText ? (
                  <div>
                    <dt>负向内容</dt>
                    <dd>{record.negativeText}</dd>
                  </div>
                ) : null}
                {record.resources.length > 0 ? (
                  <div>
                    <dt>参考资源</dt>
                    <dd>
                      {record.resources
                        .map(
                          (resource) =>
                            `${resource.assetId ?? '未知资产'}${resource.assetVersion ? `@v${resource.assetVersion}` : ''}`,
                        )
                        .join('、')}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

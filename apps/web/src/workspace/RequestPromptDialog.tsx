import type { RequestPromptRecord } from '@multimodal-canvas/domain';
import { renderRequestPromptText } from '@multimodal-canvas/domain';
import { Dialog, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { Check, Copy, Loader2, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';

/** 复制动作的短暂反馈状态。 */
type CopyState = 'idle' | 'copied' | 'failed';

/** Dialog 的加载与失败状态；记录缺失与失败都要让用户看得懂。 */
export type RequestPromptDialogState =
  | { status: 'loading' }
  | { status: 'ready'; record: RequestPromptRecord }
  | { status: 'missing' }
  | { status: 'failed'; message?: string };

type RequestPromptDialogProps = {
  state: RequestPromptDialogState;
  /** 触发按钮的可读名称，用于关闭后回焦。 */
  triggerId?: string;
  onClose: () => void;
  /** 加载失败时的重试入口；缺省表示不可重试。 */
  onRetry?: () => void;
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
  triggerId,
  onClose,
  onRetry,
}: RequestPromptDialogProps) {
  const [summaryCopy, setSummaryCopy] = useState<CopyState>('idle');
  const [promptCopy, setPromptCopy] = useState<CopyState>('idle');

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

  const record = state.status === 'ready' ? state.record : undefined;
  const fullPrompt = record ? renderRequestPromptText(record) : '';
  const summary = record?.summary ?? '';

  return (
    <Dialog
      open
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
              未记录生成提示词。该节点没有对应的生成记录，界面不会从文件名或当前编辑框推测内容。
            </p>
          ) : null}
          {record ? (
            <>
              <section className="request-prompt-block" aria-label="整体摘要">
                <div className="request-prompt-block-head">
                  <h3>整体摘要</h3>
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
                {summary ? (
                  <p className="request-prompt-summary">{summary}</p>
                ) : (
                  <p className="request-prompt-summary is-empty">
                    尚未记录摘要。摘要需要单独生成，不影响完整提示词查看与复制。
                  </p>
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

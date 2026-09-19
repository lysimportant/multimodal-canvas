import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Loader2, RefreshCw, ScanText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  fetchReversePrompt,
  reversePromptModelKey,
  submitReversePrompt,
  ReversePromptRequestError,
  type ReversePromptState,
  type ReversePromptTarget,
} from '../reverse-prompts';
import { API_BASE_URL, type ModelEntry, type ModelSelection } from './contracts';
import { QuoteCancelledError, QuoteRequestError } from '../marketplace/quote-client';
import {
  clearPendingReversePrompt,
  pendingReversePromptKey,
  readPendingReversePrompt,
  savePendingReversePrompt,
  type PendingReversePrompt,
} from './pending-reverse-prompt';

/** 反推控制的输入；账号与精确版本共同隔离查询缓存。 */
export type ReversePromptPanelProps = {
  target: ReversePromptTarget;
  userId: string;
  models: readonly ModelEntry[];
};

/**
 * 提供当前资源版本的反推操作及独立结果，真实生成记录由外层 Dialog 展示。
 * 手动提交采用稳定请求键；网络结果未知时保留原模型与键，避免误发新请求。
 */
export function ReversePromptPanel({ target, userId, models }: ReversePromptPanelProps) {
  const queryClient = useQueryClient();
  const queryKey = ['reverse-prompts', userId, target.projectId, target.assetId, target.version];
  const pinnedRunId = useRef<string | undefined>(undefined);
  const storageKey = pendingReversePromptKey(userId, target);
  const [initialSubmission] = useState<{ pending?: PendingReversePrompt; error?: string }>(() => {
    try {
      return { pending: readPendingReversePrompt(storageKey) };
    } catch {
      return { error: '无法读取待确认的反推请求，请恢复浏览器存储后重新打开' };
    }
  });
  const submission = useRef(initialSubmission.pending);
  const submittingRef = useRef(false);
  const requestController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => requestController.current?.abort(), [storageKey]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialSubmission.error);
  const [selection, setSelection] = useState<ModelSelection>();
  const [copied, setCopied] = useState<'summary' | 'prompt'>();
  const analysisQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      fetchReversePrompt(target, API_BASE_URL, { signal, runId: pinnedRunId.current }),
    retry: false,
    staleTime: 0,
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.analysis?.status ?? '') ? 1500 : false,
  });
  const analysis = analysisQuery.data?.analysis;
  const running = analysis?.status === 'queued' || analysis?.status === 'running';
  const model = submission.current?.model ?? selection ?? analysisQuery.data?.defaultModel;
  const textModels = models.filter((entry) => entry.mediaTypes.includes('text'));
  const modelValue = model ? reversePromptModelKey(model) : '';
  const hasSelectedModel = textModels.some(
    (entry) =>
      reversePromptModelKey({
        modelAlias: entry.id,
        credentialId: entry.credentialId,
        platformModelId: entry.platformModelId,
      }) === modelValue,
  );

  /** 显式提交仅发送一次 POST，成功后查询该次任务；失败保留幂等身份。 */
  const analyze = async () => {
    if (
      submittingRef.current ||
      running ||
      analysisQuery.isPending ||
      analysisQuery.isError ||
      initialSubmission.error
    )
      return;
    submittingRef.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      submission.current = readPendingReversePrompt(storageKey) ?? {
        key: `reverse-prompt-${crypto.randomUUID()}`,
        model,
      };
      savePendingReversePrompt(storageKey, submission.current);
      const result = await submitReversePrompt(target, API_BASE_URL, {
        idempotencyKey: submission.current.key,
        model: submission.current.model,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      pinnedRunId.current = result.runId;
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData<ReversePromptState>(queryKey, (current) => ({
        ...current,
        analysis: result,
      }));
      clearPendingReversePrompt(storageKey, submission.current.key);
      submission.current = undefined;
    } catch (cause) {
      if (
        cause instanceof QuoteCancelledError ||
        ((cause instanceof ReversePromptRequestError || cause instanceof QuoteRequestError) &&
          cause.status >= 400 &&
          cause.status < 500)
      ) {
        if (submission.current) clearPendingReversePrompt(storageKey, submission.current.key);
        submission.current = undefined;
      }
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : '反推提示词提交失败');
    } finally {
      if (requestController.current === controller) requestController.current = undefined;
      submittingRef.current = false;
      setBusy(false);
    }
  };

  /** 分别复制分析摘要或提示词；剪贴板拒绝时保留文本并显示错误。 */
  const copy = async (field: 'summary' | 'prompt') => {
    try {
      await navigator.clipboard.writeText(analysis?.[field] ?? '');
      setCopied(field);
    } catch {
      setError('复制失败，请选择文本后复制');
    }
  };

  return (
    <section className="reverse-prompt-panel" aria-label="资源反推提示词">
      <div className="reverse-prompt-toolbar">
        <label className="reverse-prompt-model">
          <span>文字模型</span>
          <select
            aria-label="反推文字模型"
            value={modelValue}
            disabled={busy || running || Boolean(submission.current)}
            onChange={(event) => {
              const selected = textModels.find(
                (entry) =>
                  reversePromptModelKey({
                    modelAlias: entry.id,
                    credentialId: entry.credentialId,
                    platformModelId: entry.platformModelId,
                  }) === event.target.value,
              );
              if (selected)
                setSelection({
                  modelAlias: selected.id,
                  credentialId: selected.credentialId,
                  platformModelId: selected.platformModelId,
                });
            }}
          >
            {!model ? <option value="">默认文字模型</option> : null}
            {model && !hasSelectedModel ? (
              <option value={modelValue}>{model.modelAlias}</option>
            ) : null}
            {textModels.map((entry) => {
              const key = reversePromptModelKey({
                modelAlias: entry.id,
                credentialId: entry.credentialId,
                platformModelId: entry.platformModelId,
              });
              return (
                <option
                  key={key}
                  value={key}
                  disabled={Boolean(entry.availability && entry.availability !== 'available')}
                >
                  {entry.name || entry.id}
                  {entry.credentialLabel ? ` · ${entry.credentialLabel}` : ''}
                </option>
              );
            })}
          </select>
        </label>
        <button
          type="button"
          className="request-prompt-copy"
          disabled={
            busy ||
            running ||
            analysisQuery.isPending ||
            analysisQuery.isError ||
            Boolean(initialSubmission.error)
          }
          onClick={() => void analyze()}
        >
          {busy || running ? (
            <Loader2 size={14} aria-hidden="true" />
          ) : (
            <ScanText size={14} aria-hidden="true" />
          )}
          {busy ? '提交中' : running ? '反推中' : '反推提示词'}
        </button>
      </div>
      {analysisQuery.isPending ? (
        <p className="request-prompt-status" role="status">
          正在读取反推记录…
        </p>
      ) : null}
      {analysisQuery.isError ? (
        <div className="request-prompt-status" role="alert">
          <span>{analysisQuery.error.message}</span>
          <button
            type="button"
            className="request-prompt-retry"
            onClick={() => void analysisQuery.refetch()}
          >
            <RefreshCw size={13} /> 重新查询
          </button>
        </div>
      ) : null}
      {error || analysis?.error ? (
        <p className="request-prompt-summary-error" role="alert">
          {error ?? analysis?.error}
        </p>
      ) : null}
      {analysis?.status === 'cancelled' ? <p role="status">反推已取消</p> : null}
      {analysis?.status === 'succeeded' ? (
        <>
          <div className="reverse-prompt-result-heading">
            <h3>反推结果</h3>
            <span>
              {analysis.modelAlias} · v{analysis.assetVersion}
            </span>
          </div>
          {(['summary', 'prompt'] as const).map((field) => (
            <section
              className="request-prompt-block"
              key={field}
              aria-label={field === 'summary' ? '反推整体摘要' : '反推详细提示词'}
            >
              <div className="request-prompt-block-head">
                <h4>{field === 'summary' ? '整体摘要' : '详细提示词'}</h4>
                <button
                  type="button"
                  className="request-prompt-copy"
                  aria-label={field === 'summary' ? '复制反推摘要' : '复制反推提示词'}
                  onClick={() => void copy(field)}
                >
                  {copied === field ? <Check size={13} /> : <Copy size={13} />}
                  {copied === field ? '已复制' : '复制'}
                </button>
              </div>
              <pre className="request-prompt-text">{analysis[field]}</pre>
            </section>
          ))}
        </>
      ) : null}
    </section>
  );
}

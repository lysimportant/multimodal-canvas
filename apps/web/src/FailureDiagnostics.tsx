import { Alert, Button, Descriptions, Typography } from 'antd';
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { DescriptionsProps } from 'antd';

import type { RunRecord } from '@multimodal-canvas/domain';

import './failure-diagnostics.css';

/**
 * The API keeps provider diagnostics in a sanitized payload. These optional
 * fields also let the component render newer API responses without forcing a
 * domain schema migration just for presentation concerns.
 */
export type FailureDiagnosticsRun = RunRecord & {
  errorCode?: string;
  platformJobId?: string;
  providerJobId?: string;
  requestId?: string;
  retryable?: boolean;
};

export type FailureDiagnosticsProps = {
  run?: FailureDiagnosticsRun | null;
  onRetry?: () => void | Promise<void>;
  busy?: boolean;
  className?: string;
};

export type FailureDiagnosticDetails = {
  error?: string;
  errorCode?: string;
  platformJobId?: string;
  requestId?: string;
  retryable?: boolean;
};

const terminalStatuses = new Set(['failed', 'cancelled']);

/**
 * Extract only provider-neutral fields that are safe to show in the UI.
 * Provider payloads are treated as untrusted, even though the worker already
 * sanitizes them before persistence.
 */
export function getFailureDiagnosticDetails(run: FailureDiagnosticsRun): FailureDiagnosticDetails {
  const runRecord = run as unknown as Record<string, unknown>;
  const providerJob = isRecord(run.providerJob) ? run.providerJob : undefined;
  const providerPayload = providerJob && isRecord(providerJob.payload) ? providerJob.payload : {};
  const statusResponse = isRecord(providerPayload.statusResponse)
    ? providerPayload.statusResponse
    : {};

  const error = firstString(run.error, providerPayload.error, statusResponse.error);
  const errorCode = firstString(
    runRecord.errorCode,
    providerPayload.errorCode,
    providerPayload.code,
    statusResponse.errorCode,
    statusResponse.code,
  );
  const requestId = firstString(
    runRecord.requestId,
    runRecord.request_id,
    providerPayload.requestId,
    providerPayload.request_id,
    statusResponse.requestId,
    statusResponse.request_id,
  );
  const platformJobId = firstString(
    runRecord.platformJobId,
    runRecord.providerJobId,
    providerJob?.platformJobId,
    providerJob && (providerJob as Record<string, unknown>).providerJobId,
  );
  const retryable = firstBoolean(
    runRecord.retryable,
    providerPayload.retryable,
    statusResponse.retryable,
  );

  return {
    ...(error ? { error: sanitizeErrorMessage(error) } : {}),
    ...(errorCode ? { errorCode: sanitizeIdentifier(errorCode) } : {}),
    ...(platformJobId ? { platformJobId: sanitizeIdentifier(platformJobId) } : {}),
    ...(requestId ? { requestId: sanitizeIdentifier(requestId) } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (value.trim().toLowerCase() === 'true') return true;
      if (value.trim().toLowerCase() === 'false') return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return undefined;
}

function sanitizeIdentifier(value: string): string | undefined {
  const normalized = value.trim().slice(0, 256);
  if (!normalized || isCredentialLike(normalized) || /^(?:https?|data|blob):/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function sanitizeErrorMessage(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(
      /(authorization|api[-_]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[已隐藏]',
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[已隐藏]')
    .replace(/([?&](?:api[-_]?key|token|secret|password|authorization)=)[^&\s]+/gi, '$1[已隐藏]')
    .slice(0, 2_000);
  return normalized || undefined;
}

function isCredentialLike(value: string): boolean {
  return (
    /\bsk-[a-z0-9_-]{8,}\b/i.test(value) ||
    /(authorization|api[-_]?key|token|secret|password|credential)\s*[:=]/i.test(value)
  );
}

function statusLabel(status: FailureDiagnosticsRun['status']): string {
  return status === 'cancelled' ? '已取消' : '失败';
}

function retryLabel(retryable: boolean | undefined): string {
  if (retryable === true) return '可重试';
  if (retryable === false) return '不可重试';
  return '未标记';
}

export function FailureDiagnostics({
  run,
  onRetry,
  busy = false,
  className,
}: FailureDiagnosticsProps) {
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  if (!run) return null;
  const details = getFailureDiagnosticDetails(run);
  const isTerminal = terminalStatuses.has(run.status);
  if (!isTerminal && !details.error) return null;

  const canRetry = isTerminal && details.retryable !== false && Boolean(onRetry);
  const isRetrying = busy || retryBusy;
  const rootClassName = ['failure-diagnostics', className].filter(Boolean).join(' ');

  const handleRetry = async () => {
    if (!onRetry || !canRetry || isRetrying) return;
    setRetryError(null);
    setRetryBusy(true);
    try {
      await onRetry();
    } catch (error) {
      const message = error instanceof Error ? error.message : '重试提交失败';
      setRetryError(sanitizeErrorMessage(message) ?? '重试提交失败');
    } finally {
      setRetryBusy(false);
    }
  };

  const detailItems: DescriptionsProps['items'] = [
    {
      key: 'retryable',
      label: '可重试性',
      children: (
        <span
          className={`failure-diagnostics-retryability failure-diagnostics-retryability-${
            details.retryable === true ? 'yes' : details.retryable === false ? 'no' : 'unknown'
          }`}
        >
          {retryLabel(details.retryable)}
        </span>
      ),
    },
  ];
  if (details.errorCode) {
    detailItems.push({
      key: 'errorCode',
      label: '错误代码',
      children: <Typography.Text code>{details.errorCode}</Typography.Text>,
    });
  }
  if (details.requestId) {
    detailItems.push({
      key: 'requestId',
      label: '请求 ID',
      children: <Typography.Text code>{details.requestId}</Typography.Text>,
    });
  }
  if (details.platformJobId) {
    detailItems.push({
      key: 'platformJobId',
      label: '平台任务 ID',
      children: <Typography.Text code>{details.platformJobId}</Typography.Text>,
    });
  }

  return (
    <section className={rootClassName} aria-label="运行失败诊断" data-testid="failure-diagnostics">
      <div className="failure-diagnostics-heading">
        <div className="failure-diagnostics-title">
          {details.retryable === false ? (
            <ShieldAlert size={16} aria-hidden="true" />
          ) : (
            <AlertTriangle size={16} aria-hidden="true" />
          )}
          <div>
            <span className="failure-diagnostics-eyebrow">运行诊断</span>
            <h3>{statusLabel(run.status)}</h3>
          </div>
        </div>
        <span
          className={`failure-diagnostics-status failure-diagnostics-status-${
            run.status === 'cancelled' ? 'cancelled' : 'failed'
          }`}
        >
          {run.status === 'cancelled' ? '已取消' : '失败'}
        </span>
      </div>

      <Alert
        type="error"
        showIcon
        title="错误信息"
        description={details.error ?? '运行未返回具体错误信息。'}
      />

      <Descriptions column={1} size="small" colon={false} items={detailItems} />

      {details.retryable === false && (
        <Typography.Text type="danger" className="failure-diagnostics-hint">
          {details.errorCode === 'UNSUPPORTED_INPUT_ROLE'
            ? '当前模型不接受该输入端口，请检查节点连线，或改用支持此媒体输入的模型。'
            : '服务端标记此任务不可重试，请检查模型和输入后重新运行。'}
        </Typography.Text>
      )}
      {retryError && (
        <Typography.Text type="danger" className="failure-diagnostics-retry-error">
          {retryError}
        </Typography.Text>
      )}
      {canRetry && (
        <Button
          className="button button-secondary failure-diagnostics-retry"
          icon={<RotateCcw size={14} aria-hidden="true" />}
          loading={
            isRetrying
              ? { icon: <CheckCircle2 className="spin" size={14} aria-hidden="true" /> }
              : false
          }
          disabled={isRetrying}
          aria-busy={isRetrying}
          onClick={() => void handleRetry()}
        >
          {isRetrying ? '重试中' : '重试'}
        </Button>
      )}
    </section>
  );
}

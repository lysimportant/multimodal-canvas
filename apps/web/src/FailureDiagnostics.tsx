import { Alert, Button, Descriptions, Typography } from 'antd';
import { AlertTriangle, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import type { DescriptionsProps } from 'antd';

import type { PortRole, RunRecord } from '@multimodal-canvas/domain';

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

/** 归档阶段：下载上游结果 → 写入对象存储 → 登记结果。 */
export type ArchiveFailureStage = 'download' | 'storage' | 'archive';

/** 一次归档尝试的脱敏记录。 */
export type ArchiveFailureAttempt = {
  attempt: number;
  message: string;
  /** 合法的 ISO 时间戳；缺失或非法时不展示。 */
  at?: string;
};

/** 从不可信的 providerJob.payload 中解析出的归档失败展示信息。 */
export type ArchiveFailureDetails = {
  stage?: ArchiveFailureStage;
  attempt?: number;
  firstError?: string;
  lastError?: string;
  failures: ArchiveFailureAttempt[];
};

/** 本次运行冻结的一张参考素材；只保留展示必需的脱敏字段。 */
export type RunReferenceInput = {
  nodeId: string;
  role: PortRole;
  sortOrder: number;
  label: string;
  assetId?: string;
  shortAssetId?: string;
  version?: number;
};

const terminalStatuses = new Set(['failed', 'cancelled']);

/** 图片语义端口；即使节点快照暂时缺少 mimeType，也按参考图展示。 */
const imageReferenceRoles: ReadonlySet<PortRole> = new Set<PortRole>([
  'content',
  'style',
  'character',
  'referenceImage',
  'firstFrame',
  'lastFrame',
  'imageEdit',
]);

/** 预检失败时 Worker 记录的固定标记：本次运行没有真正提交生成请求。 */
const notSubmittedMarker = '本次未提交生成请求';

const providerJobIdPreviewLength = 12;

/** 归档失败的结构化标记；兼容旧运行里只有自然语言错误的记录。 */
const archiveFailureMarker = '归档失败';

const archiveFailureStageLabels: Record<ArchiveFailureStage, string> = {
  download: '结果下载',
  storage: '对象存储写入',
  archive: '结果归档',
};

const maxArchiveAttempts = 5;

const maxArchiveErrorLength = 500;

const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 归档失败原因最多展示 5 次尝试，且每条消息都按不可信文本脱敏、截断。 */
export function getArchiveFailureDetails(
  run: FailureDiagnosticsRun,
): ArchiveFailureDetails | undefined {
  const payload = providerJobPayload(run);
  const failures = parseArchiveFailures(payload.archiveFailures);
  const stage = parseArchiveStage(payload.archiveStage);
  const attempt = parseArchiveAttempt(payload.archiveAttempt);
  const firstError = sanitizeArchiveError(payload.firstArchiveError) ?? failures[0]?.message;
  const lastError =
    sanitizeArchiveError(payload.lastArchiveError) ?? failures[failures.length - 1]?.message;
  const isArchiveFailure =
    failureErrorText(run).includes(archiveFailureMarker) ||
    stage !== undefined ||
    lastError !== undefined ||
    failures.length > 0;
  if (!isArchiveFailure) return undefined;

  return {
    ...(stage ? { stage } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(firstError ? { firstError } : {}),
    ...(lastError ? { lastError } : {}),
    failures,
  };
}

/**
 * Extract only provider-neutral fields that are safe to show in the UI.
 * Provider payloads are treated as untrusted, even though the worker already
 * sanitizes them before persistence.
 */
export function getFailureDiagnosticDetails(run: FailureDiagnosticsRun): FailureDiagnosticDetails {
  const runRecord = run as unknown as Record<string, unknown>;
  const providerJob = isRecord(run.providerJob) ? run.providerJob : undefined;
  const providerPayload = providerJobPayload(run);
  const statusResponse: Record<string, unknown> = isRecord(providerPayload.statusResponse)
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
    isRecord(providerJob?.payload) ? providerJob.payload.providerJobId : undefined,
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

/**
 * 列出本次运行冻结的图片参考素材，按冻结顺序展示。
 * 节点后续改图不会改变这份历史快照，因此名称与版本都从快照读取。
 */
export function getRunReferenceInputs(run: FailureDiagnosticsRun): RunReferenceInput[] {
  const inputs = Array.isArray(run.snapshot?.inputs) ? run.snapshot.inputs : [];
  const references: RunReferenceInput[] = [];
  for (const input of inputs) {
    const reference = toRunReferenceInput(input);
    if (reference) references.push(reference);
  }
  return references.sort((left, right) =>
    left.sortOrder === right.sortOrder
      ? left.nodeId.localeCompare(right.nodeId)
      : left.sortOrder - right.sortOrder,
  );
}

/**
 * 描述本次运行是否真正把生成请求发送给上游。
 * 预检失败标记优先：有该标记时即使存在陈旧 providerJob 也不能说已经发送。
 */
export function describeRunSendStatus(run: FailureDiagnosticsRun): string {
  const error = failureErrorText(run);
  if (error.includes(notSubmittedMarker)) return '未发送（提交前素材预检失败）';
  if (run.providerJob) {
    const providerJobId = shortProviderJobId(run);
    return providerJobId ? `已提交（上游任务 '${providerJobId}'）` : '已提交（上游任务）';
  }
  if (run.result) return '已提交并返回结果';
  if (run.status === 'cancelled') return '已取消';
  return '已提交，结果未返回';
}

/**
 * 把失败映射到可解释的阶段；顺序即优先级，先命中先返回。
 * 只用于展示，不改变重试或任何服务端行为。
 */
export function classifyRunFailureStage(run: FailureDiagnosticsRun): string {
  const error = failureErrorText(run);
  if (error.includes('预检失败') || error.includes(notSubmittedMarker)) {
    return '素材公网可读性预检';
  }
  if (/authentication|认证|401|api\s*密钥/i.test(error)) return '上游认证';
  if (/resolution|参数|invalid|400/i.test(error)) return '上游参数校验';
  // 生成成功后归档失败时 providerJob 依然存在，必须先于“上游生成任务”判断，
  // 否则真实失败阶段会被误报成生成任务阶段。
  if (getArchiveFailureDetails(run)) return '结果归档';
  if (run.providerJob || /fail_to_fetch_task/i.test(error)) return '上游生成任务';
  if (/归档|archive|下载/i.test(error)) return '结果归档';
  return '未知阶段';
}

function toRunReferenceInput(
  input: FailureDiagnosticsRun['snapshot']['inputs'][number],
): RunReferenceInput | undefined {
  const data: FailureDiagnosticsRun['snapshot']['nodes'][number]['data'] | undefined =
    input.snapshot?.data;
  if (!isImageReference(input.role, data?.mediaType, data?.mimeType)) return undefined;
  const assetId = firstString(input.sourceAssetId, data?.assetId);
  const version = input.sourceAssetVersion ?? parseAssetVersion(data?.contentUrl);
  const label =
    firstString(data?.label) ?? (assetId ? `资产 ${shortAssetId(assetId)}` : input.nodeId);
  return {
    nodeId: input.nodeId,
    role: input.role,
    sortOrder: input.sortOrder,
    label,
    ...(assetId ? { assetId, shortAssetId: shortAssetId(assetId) } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

function isImageReference(
  role: PortRole,
  mediaType: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (mediaType === 'image') return true;
  if (typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')) return true;
  return imageReferenceRoles.has(role);
}

function parseAssetVersion(contentUrl: string | undefined): number | undefined {
  if (!contentUrl) return undefined;
  const match = /\/versions\/(\d+)(?:\/|$)/.exec(contentUrl);
  const version = Number.parseInt(match?.[1] ?? '', 10);
  return Number.isInteger(version) && version > 0 ? version : undefined;
}

function shortAssetId(assetId: string): string {
  return assetId.trim().slice(0, 8);
}

function failureErrorText(run: FailureDiagnosticsRun): string {
  return firstString(run.error, getFailureDiagnosticDetails(run).error) ?? '';
}

/** providerJob.payload 是旧接口也可能缺失的不可信记录，统一安全取出。 */
function providerJobPayload(run: FailureDiagnosticsRun): Record<string, unknown> {
  const providerJob = isRecord(run.providerJob) ? run.providerJob : undefined;
  return providerJob && isRecord(providerJob.payload) ? providerJob.payload : {};
}

function parseArchiveFailures(value: unknown): ArchiveFailureAttempt[] {
  if (!Array.isArray(value)) return [];
  const failures: ArchiveFailureAttempt[] = [];
  for (const entry of value) {
    if (failures.length >= maxArchiveAttempts) break;
    if (!isRecord(entry)) continue;
    const attempt = parseArchiveAttempt(entry.attempt);
    const message = sanitizeArchiveError(entry.message);
    if (attempt === undefined || !message) continue;
    const at = parseArchiveAttemptTimestamp(entry.at);
    failures.push({ attempt, message, ...(at ? { at } : {}) });
  }
  return failures;
}

function parseArchiveStage(value: unknown): ArchiveFailureStage | undefined {
  if (value === 'download' || value === 'storage' || value === 'archive') return value;
  return undefined;
}

function parseArchiveAttempt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return value;
}

function parseArchiveAttemptTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!isoDateTimePattern.test(normalized)) return undefined;
  return Number.isNaN(Date.parse(normalized)) ? undefined : normalized;
}

function sanitizeArchiveError(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeErrorMessage(value);
  if (!sanitized) return undefined;
  return sanitized.length > maxArchiveErrorLength
    ? `${sanitized.slice(0, maxArchiveErrorLength)}…`
    : sanitized;
}

/** 归档尝试时间按本地时区展示为 HH:mm:ss；非法时间省略。 */
function formatArchiveAttemptTime(isoTimestamp: string): string | undefined {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) return undefined;
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function archiveFailureStageLabel(stage: ArchiveFailureStage): string {
  return archiveFailureStageLabels[stage];
}

function shortProviderJobId(run: FailureDiagnosticsRun): string | undefined {
  const providerJob = run.providerJob;
  if (!providerJob) return undefined;
  const rawId = firstString(providerJob.platformJobId, providerJob.id);
  const identifier = rawId ? sanitizeIdentifier(rawId) : undefined;
  return identifier ? identifier.slice(0, providerJobIdPreviewLength) : undefined;
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

/**
 * 错误串按不可信内容处理：先脱敏签名 URL 的查询串/片段，再隐藏密钥类键值，
 * 最终只保留可解释的文本，绝不把完整签名链接或 token 交给界面。
 */
function sanitizeErrorMessage(value: string): string | undefined {
  const normalized = value
    .trim()
    .replace(/https?:\/\/[^\s<>"'`]+/gi, stripUrlSecrets)
    .replace(/\bdata:[^\s<>"'`]+/gi, '[已隐藏]')
    .replace(/\b(?:access|refresh|id|auth)[-_]?token\b\s*[:=]\s*[^\s,;&]+/gi, '[已隐藏]')
    .replace(
      /\b(?:x-amz-signature|x-amz-credential|x-amz-date|signature|sig|expires)\s*[:=]\s*[^\s,;&]+/gi,
      '[已隐藏]',
    )
    .replace(
      /(authorization|api[-_]?key|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[已隐藏]',
    )
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, '[已隐藏]')
    .replace(/([?&][^=&\s]+)=[^&\s]*/g, '$1=[已隐藏]')
    .slice(0, 2_000);
  return normalized || undefined;
}

function stripUrlSecrets(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
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

  const sendStatus = isTerminal ? describeRunSendStatus(run) : undefined;
  const failureStage = isTerminal ? classifyRunFailureStage(run) : undefined;
  const archiveFailure = isTerminal ? getArchiveFailureDetails(run) : undefined;
  const referenceInputs = isTerminal ? getRunReferenceInputs(run) : [];

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

  const detailItems: NonNullable<DescriptionsProps['items']> = [];
  if (isTerminal) {
    detailItems.push(
      {
        key: 'sendStatus',
        label: '本次运行发送状态',
        children: (
          <span
            className="failure-diagnostics-send-status"
            data-testid="failure-diagnostics-send-status"
          >
            {sendStatus}
          </span>
        ),
      },
      {
        key: 'failureStage',
        label: '失败阶段',
        children: (
          <span
            className="failure-diagnostics-failure-stage"
            data-testid="failure-diagnostics-failure-stage"
          >
            {failureStage}
          </span>
        ),
      },
    );
  }
  if (archiveFailure?.stage) {
    detailItems.push({
      key: 'archiveStage',
      label: '归档阶段',
      children: (
        <span
          className="failure-diagnostics-archive-stage"
          data-testid="failure-diagnostics-archive-stage"
        >
          {archiveFailureStageLabel(archiveFailure.stage)}
        </span>
      ),
    });
  }
  if (archiveFailure?.attempt !== undefined) {
    detailItems.push({
      key: 'archiveAttempt',
      label: '归档尝试',
      children: (
        <span
          className="failure-diagnostics-archive-attempt-count"
          data-testid="failure-diagnostics-archive-attempt"
        >
          第 {archiveFailure.attempt} 次尝试
        </span>
      ),
    });
  }
  detailItems.push({
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
  });
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
  // 归档错误只在确实带来新信息时展示：与顶部 Alert（run.error 的脱敏文本）
  // 完全相同的错误不再重复一行。
  if (archiveFailure?.firstError && archiveFailure.firstError !== details.error) {
    detailItems.push({
      key: 'archiveFirstError',
      label: '首次归档错误',
      children: (
        <span
          className="failure-diagnostics-archive-error"
          data-testid="failure-diagnostics-archive-first-error"
        >
          {archiveFailure.firstError}
        </span>
      ),
    });
  }
  if (archiveFailure?.lastError && archiveFailure.lastError !== details.error) {
    detailItems.push({
      key: 'archiveLastError',
      label: '最近归档错误',
      children: (
        <span
          className="failure-diagnostics-archive-error"
          data-testid="failure-diagnostics-archive-last-error"
        >
          {archiveFailure.lastError}
        </span>
      ),
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

      {archiveFailure && archiveFailure.failures.length > 0 && (
        <div
          className="failure-diagnostics-archive-attempts"
          aria-label="本次运行归档重试记录"
          data-testid="failure-diagnostics-archive-attempts"
        >
          <span className="failure-diagnostics-section-title">本次运行归档重试记录</span>
          <ol className="failure-diagnostics-archive-attempt-list">
            {archiveFailure.failures.map((failure, index) => {
              const timeLabel = failure.at ? formatArchiveAttemptTime(failure.at) : undefined;
              return (
                <li
                  className="failure-diagnostics-archive-attempt"
                  key={`${failure.attempt}:${failure.at ?? ''}:${index}`}
                >
                  <span className="failure-diagnostics-archive-attempt-sequence">
                    第 {failure.attempt} 次：
                  </span>
                  <span className="failure-diagnostics-archive-attempt-message">
                    {failure.message}
                  </span>
                  {timeLabel && failure.at ? (
                    <time
                      className="failure-diagnostics-archive-attempt-time"
                      dateTime={failure.at}
                    >
                      {timeLabel}
                    </time>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {referenceInputs.length > 0 && (
        <div
          className="failure-diagnostics-references"
          aria-label="本次运行参考素材"
          data-testid="failure-diagnostics-references"
        >
          <span className="failure-diagnostics-section-title">本次运行参考素材</span>
          <ul className="failure-diagnostics-reference-list">
            {referenceInputs.map((reference) => (
              <li
                className="failure-diagnostics-reference"
                key={`${reference.nodeId}:${reference.sortOrder}`}
              >
                <span className="failure-diagnostics-reference-label">{reference.label}</span>
                <span className="failure-diagnostics-reference-meta">
                  <span className="failure-diagnostics-reference-kind">
                    {reference.version === undefined ? '图片' : `图片 · v${reference.version}`}
                  </span>
                  {reference.shortAssetId ? (
                    <Typography.Text code className="failure-diagnostics-reference-id">
                      {reference.shortAssetId}
                    </Typography.Text>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

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

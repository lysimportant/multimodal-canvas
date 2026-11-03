import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasNode, PortRole, RunInputSnapshot } from '@multimodal-canvas/domain';

import type { FailureDiagnosticsRun } from './FailureDiagnostics';
import {
  classifyRunFailureStage,
  describeRunSendStatus,
  FailureDiagnostics,
  getArchiveFailureDetails,
  getFailureDiagnosticDetails,
  getRunReferenceInputs,
} from './FailureDiagnostics';

function syntheticApiKey(...segments: string[]): string {
  return [['s', 'k'].join(''), ...segments].join('-');
}

function makeRun(overrides: Record<string, unknown> = {}): FailureDiagnosticsRun {
  return {
    id: 'run_failure_1',
    projectId: 'project_1',
    targetNodeId: 'node_1',
    status: 'failed',
    progress: 82,
    attempt: 1,
    provider: 'newapi',
    modelAlias: 'text-model',
    snapshot: {} as FailureDiagnosticsRun['snapshot'],
    createdAt: '2026-08-27T00:00:00.000Z',
    updatedAt: '2026-08-27T00:01:00.000Z',
    ...overrides,
  } as FailureDiagnosticsRun;
}

type SnapshotInputOptions = {
  nodeId?: string;
  role: PortRole;
  sortOrder?: number;
  sourceAssetId?: string;
  sourceAssetVersion?: number;
  label?: string;
  mediaType?: 'image' | 'text' | 'audio' | 'video';
  mimeType?: string;
  contentUrl?: string;
};

function makeSnapshotInput(options: SnapshotInputOptions): RunInputSnapshot {
  const {
    nodeId = 'node-ref',
    role,
    sortOrder = 0,
    sourceAssetId,
    sourceAssetVersion,
    label,
    mediaType = 'image',
    mimeType,
    contentUrl,
  } = options;
  return {
    nodeId,
    role,
    sortOrder,
    ...(sourceAssetId ? { sourceAssetId } : {}),
    ...(sourceAssetVersion !== undefined ? { sourceAssetVersion } : {}),
    snapshot: {
      id: nodeId,
      type: mediaType,
      position: { x: 0, y: 0 },
      data: {
        label: label ?? '',
        mediaType,
        mode: 'source',
        ...(mimeType ? { mimeType } : {}),
        ...(contentUrl ? { contentUrl } : {}),
      },
    } as unknown as CanvasNode,
  };
}

function snapshotWithInputs(inputs: RunInputSnapshot[]): FailureDiagnosticsRun['snapshot'] {
  return { inputs } as unknown as FailureDiagnosticsRun['snapshot'];
}

const preflightError =
  '参考素材公网可读性预检失败：网络、DNS 或 TLS 连接不可用，请检查公网素材入口；本次未提交生成请求。';

const archiveFirstError = '归档下载被中止：aborted';
const archiveLatestError =
  '上游结果下载失败（HTTP 502，artifact_request_rejected：Artifact redirect was rejected）';

/** 用本地时间构造 ISO 字符串，避免断言里的 HH:mm:ss 受测试机时区影响。 */
function localIsoTime(hour: number, minute: number, second: number): string {
  return new Date(2026, 7, 27, hour, minute, second).toISOString();
}

function makeArchivePayload(): Record<string, unknown> {
  return {
    archiveStage: 'download',
    archiveAttempt: 2,
    firstArchiveError: archiveFirstError,
    lastArchiveError: archiveLatestError,
    archiveFailures: [
      {
        attempt: 1,
        message: `归档下载失败（第 1 次尝试）：${archiveFirstError}`,
        at: localIsoTime(12, 0, 30),
      },
      {
        attempt: 2,
        message: archiveLatestError,
        at: localIsoTime(12, 3, 5),
      },
    ],
  };
}

function makeArchiveRun(): FailureDiagnosticsRun {
  return makeRun({
    error: `生成已完成，归档失败（第 2 次尝试）：${archiveLatestError}。仅重试归档，不会重新生成`,
    providerJob: {
      id: 'job_archive',
      provider: 'newapi',
      platformJobId: 'platform_archive',
      status: 'failed',
      progress: 100,
      payload: makeArchivePayload(),
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:05:00.000Z',
    },
  });
}

const referenceInputs = [
  makeSnapshotInput({
    nodeId: 'node-char-ref',
    role: 'referenceImage',
    sortOrder: 0,
    sourceAssetId: '887d40ec-b38c-4891-80df-eec9e6b06594',
    sourceAssetVersion: 1,
    label: '人物定妆 · 陈砚（四视图）',
    contentUrl: '/v1/assets/887d40ec-b38c-4891-80df-eec9e6b06594/versions/1/content',
    mimeType: 'image/png',
  }),
  makeSnapshotInput({
    nodeId: 'node-scene-ref',
    role: 'referenceImage',
    sortOrder: 1,
    sourceAssetId: '6e050cf8-8f8a-4d3e-98b1-e2f78fef2d72',
    contentUrl: '/v1/assets/6e050cf8-8f8a-4d3e-98b1-e2f78fef2d72/versions/3/content',
    mimeType: 'image/jpeg',
  }),
  makeSnapshotInput({
    nodeId: 'node-prompt',
    role: 'prompt',
    sortOrder: 2,
    label: '提示词文本',
    mediaType: 'text',
  }),
];

describe('FailureDiagnostics', () => {
  afterEach(() => {
    cleanup();
  });

  it('shows safe error details and extracts provider diagnostics', () => {
    const unsafeApiKey = syntheticApiKey('super', 'secret', 'value');
    const run = makeRun({
      error: `gateway rejected request apiKey=${unsafeApiKey}`,
      errorCode: 'rate_limit',
      requestId: 'req-top-level',
      retryable: true,
      providerJob: {
        id: 'job_1',
        provider: 'newapi',
        platformJobId: 'platform_123',
        status: 'failed',
        progress: 82,
        payload: {
          requestId: 'req-provider',
          retryable: false,
          statusResponse: { requestId: 'req-status', code: 'ignored_code' },
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });

    render(<FailureDiagnostics run={run} />);

    expect(screen.getByTestId('failure-diagnostics')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('apiKey=[已隐藏]');
    expect(screen.getByRole('alert')).not.toHaveTextContent(unsafeApiKey);
    expect(screen.getByText('rate_limit')).toBeInTheDocument();
    expect(screen.getByText('req-top-level')).toBeInTheDocument();
    expect(screen.getByText('platform_123')).toBeInTheDocument();
    expect(screen.getByText('可重试')).toBeInTheDocument();
  });

  it('supports retry and keeps the action busy while the callback is pending', async () => {
    let resolveRetry!: () => void;
    const onRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    render(<FailureDiagnostics run={makeRun({ retryable: true })} onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: '重试' });
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '重试中' })).toBeDisabled();

    resolveRetry();
    await waitFor(() => expect(screen.getByRole('button', { name: '重试' })).toBeEnabled());
  });

  it('does not offer retry when the provider marks a run non-retryable', () => {
    const run = makeRun({
      providerJob: {
        payload: { retryable: false, error: 'invalid model' },
      },
    });
    render(<FailureDiagnostics run={run} onRetry={vi.fn()} />);

    expect(screen.getByText('不可重试')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(screen.getByText(/不可重试，请检查模型和输入/)).toBeInTheDocument();
  });

  it('explains unsupported input roles without exposing provider details', () => {
    const run = makeRun({
      error: 'New API image 不支持该输入角色：content',
      errorCode: 'UNSUPPORTED_INPUT_ROLE',
      retryable: false,
    });
    render(<FailureDiagnostics run={run} onRetry={vi.fn()} />);

    expect(screen.getByText(/当前模型不接受该输入端口/)).toBeInTheDocument();
  });

  it('surfaces a safe retry error and hides itself for non-failure runs without errors', async () => {
    const unsafeRetryToken = syntheticApiKey('sensitive');
    const onRetry = vi.fn().mockRejectedValue(new Error(`token=${unsafeRetryToken} failed`));
    const view = render(
      <FailureDiagnostics run={makeRun({ retryable: true })} onRetry={onRetry} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() =>
      expect(screen.getByText(/重试提交失败|token=\[已隐藏\]/)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('failure-diagnostics')).not.toHaveTextContent(unsafeRetryToken);

    view.rerender(<FailureDiagnostics run={makeRun({ status: 'running', error: undefined })} />);
    expect(screen.queryByTestId('failure-diagnostics')).not.toBeInTheDocument();
  });

  it('supports top-level aliases without exposing credential-shaped identifiers', () => {
    const unsafeProviderJobId = syntheticApiKey('platform', 'secret');
    const run = makeRun({
      status: 'cancelled',
      providerJobId: unsafeProviderJobId,
      requestId: 'request-safe',
      retryable: false,
    });
    expect(getFailureDiagnosticDetails(run)).toMatchObject({
      requestId: 'request-safe',
      retryable: false,
    });
    expect(getFailureDiagnosticDetails(run).platformJobId).toBeUndefined();
  });

  it('shows frozen reference images and the preflight failure stage for preflight errors', () => {
    const run = makeRun({
      error: preflightError,
      snapshot: snapshotWithInputs(referenceInputs),
    });
    render(<FailureDiagnostics run={run} />);

    expect(screen.getByTestId('failure-diagnostics-send-status')).toHaveTextContent(
      '未发送（提交前素材预检失败）',
    );
    expect(screen.getByTestId('failure-diagnostics-failure-stage')).toHaveTextContent(
      '素材公网可读性预检',
    );

    const references = screen.getByTestId('failure-diagnostics-references');
    expect(references).toHaveTextContent('本次运行参考素材');
    expect(references).toHaveTextContent('人物定妆 · 陈砚（四视图）');
    expect(references).toHaveTextContent('图片 · v1');
    expect(references).toHaveTextContent('887d40ec');
    // Label 缺失时回退到「资产 <短 id>」，版本从 contentUrl 解析。
    expect(references).toHaveTextContent('资产 6e050cf8');
    expect(references).toHaveTextContent('图片 · v3');
    // 非图片输入不进入参考素材列表。
    expect(references).not.toHaveTextContent('提示词文本');
  });

  it('shows the provider job id and generation task stage for provider failures', () => {
    const run = makeRun({
      error: 'provider fail_to_fetch_task',
      providerJob: {
        id: 'job_abc',
        provider: 'newapi',
        platformJobId: 'platform_123',
        status: 'failed',
        progress: 0,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });
    render(<FailureDiagnostics run={run} />);

    expect(screen.getByTestId('failure-diagnostics-send-status')).toHaveTextContent(
      "已提交（上游任务 'platform_123'）",
    );
    expect(screen.getByTestId('failure-diagnostics-failure-stage')).toHaveTextContent(
      '上游生成任务',
    );
    expect(screen.queryByTestId('failure-diagnostics-references')).not.toBeInTheDocument();
  });

  it('marks a cancelled run as cancelled without a failure stage guess', () => {
    render(<FailureDiagnostics run={makeRun({ status: 'cancelled' })} />);

    expect(screen.getByTestId('failure-diagnostics-send-status')).toHaveTextContent('已取消');
    expect(screen.queryByTestId('failure-diagnostics-references')).not.toBeInTheDocument();
  });

  it('renders no diagnostics for successful runs', () => {
    render(<FailureDiagnostics run={makeRun({ status: 'succeeded' })} />);

    expect(screen.queryByTestId('failure-diagnostics')).not.toBeInTheDocument();
    expect(screen.queryByTestId('failure-diagnostics-references')).not.toBeInTheDocument();
  });

  it('strips signed URL queries, fragments and tokens from displayed errors', () => {
    const signedUrl =
      'https://media.example.com/v1/assets/asset-1/versions/1/content?access_token=super-secret&X-Amz-Signature=deadbeef#frag';
    const run = makeRun({ error: `素材下载失败：${signedUrl}` });
    render(<FailureDiagnostics run={run} />);

    const panel = screen.getByTestId('failure-diagnostics');
    expect(panel).not.toHaveTextContent('access_token=');
    expect(panel).not.toHaveTextContent('super-secret');
    expect(panel).not.toHaveTextContent('X-Amz-Signature');
    expect(panel).not.toHaveTextContent('?');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'https://media.example.com/v1/assets/asset-1/versions/1/content',
    );
  });

  it('shows the archive stage, attempt, first/last errors and per-attempt retry records', () => {
    render(<FailureDiagnostics run={makeArchiveRun()} />);

    // 生成成功、仅归档失败时，失败阶段必须指向归档而不是“上游生成任务”。
    expect(screen.getByTestId('failure-diagnostics-failure-stage')).toHaveTextContent('结果归档');
    expect(screen.getByTestId('failure-diagnostics-archive-stage')).toHaveTextContent('结果下载');
    expect(screen.getByTestId('failure-diagnostics-archive-attempt')).toHaveTextContent(
      '第 2 次尝试',
    );
    expect(screen.getByTestId('failure-diagnostics-archive-first-error')).toHaveTextContent(
      archiveFirstError,
    );
    expect(screen.getByTestId('failure-diagnostics-archive-last-error')).toHaveTextContent(
      'HTTP 502',
    );
    // run.error 中的最新真实错误（502 + artifact_request_rejected）在顶部 Alert 可见。
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 502');
    expect(screen.getByRole('alert')).toHaveTextContent('artifact_request_rejected');

    const attempts = screen.getByTestId('failure-diagnostics-archive-attempts');
    expect(screen.getByLabelText('本次运行归档重试记录')).toBe(attempts);
    expect(attempts.querySelectorAll('li')).toHaveLength(2);
    expect(attempts).toHaveTextContent('第 1 次：');
    expect(attempts).toHaveTextContent('第 2 次：');
    expect(attempts).toHaveTextContent(archiveFirstError);
    expect(attempts).toHaveTextContent(archiveLatestError);
    expect(attempts).toHaveTextContent('12:00:30');
    expect(attempts).toHaveTextContent('12:03:05');
  });

  it('does not repeat archive errors that are already shown in the alert', () => {
    const sharedError = '上游结果下载失败（HTTP 502）';
    const run = makeRun({
      error: sharedError,
      providerJob: {
        id: 'job_archive',
        provider: 'newapi',
        status: 'failed',
        progress: 100,
        payload: {
          archiveStage: 'storage',
          archiveAttempt: 1,
          lastArchiveError: sharedError,
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });
    render(<FailureDiagnostics run={run} />);

    expect(screen.getByTestId('failure-diagnostics-archive-stage')).toHaveTextContent(
      '对象存储写入',
    );
    expect(screen.getByTestId('failure-diagnostics-archive-attempt')).toHaveTextContent(
      '第 1 次尝试',
    );
    // 与 Alert 文本相同的错误不再单独占一行。
    expect(screen.queryByTestId('failure-diagnostics-archive-last-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('failure-diagnostics-archive-first-error')).not.toBeInTheDocument();
    // 没有逐次记录时不渲染重试记录区块。
    expect(screen.queryByTestId('failure-diagnostics-archive-attempts')).not.toBeInTheDocument();
  });

  it('sanitizes signed URLs and tokens from archive payloads', () => {
    const signedUrl =
      'https://media.example.com/v1/results/run-1/content?access_token=super-secret&X-Amz-Signature=deadbeef';
    const run = makeRun({
      error: '生成已完成，归档失败：结果下载失败。仅重试归档，不会重新生成',
      providerJob: {
        id: 'job_archive',
        provider: 'newapi',
        status: 'failed',
        progress: 100,
        payload: {
          archiveStage: 'download',
          archiveAttempt: 1,
          firstArchiveError: `上游结果下载失败：${signedUrl}`,
          lastArchiveError: `上游结果下载失败：${signedUrl}`,
          archiveFailures: [
            {
              attempt: 1,
              message: `归档下载失败 token=super-secret：${signedUrl}`,
              at: 'not-an-iso-timestamp',
            },
          ],
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });
    render(<FailureDiagnostics run={run} />);

    const panel = screen.getByTestId('failure-diagnostics');
    expect(panel).not.toHaveTextContent('super-secret');
    expect(panel).not.toHaveTextContent('access_token=');
    expect(panel).not.toHaveTextContent('X-Amz-Signature');
    expect(panel).not.toHaveTextContent('?');

    const lastError = screen.getByTestId('failure-diagnostics-archive-last-error');
    expect(lastError).toHaveTextContent('https://media.example.com/v1/results/run-1/content');
    expect(lastError).not.toHaveTextContent('deadbeef');

    const attempts = screen.getByTestId('failure-diagnostics-archive-attempts');
    expect(attempts).toHaveTextContent('第 1 次：');
    expect(attempts).not.toHaveTextContent('super-secret');
    // 非法 at 不展示时间。
    expect(attempts.querySelector('time')).toBeNull();
  });

  it('does not render archive diagnostics for non-archive failures or non-terminal runs', () => {
    const authRun = makeRun({
      error: 'Authentication failed: invalid api 密钥 (401)',
      retryable: false,
      providerJob: {
        id: 'job_auth',
        provider: 'newapi',
        status: 'failed',
        progress: 0,
        payload: { requestId: 'req-auth' },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });
    expect(getArchiveFailureDetails(authRun)).toBeUndefined();
    const view = render(<FailureDiagnostics run={authRun} />);
    expect(screen.queryByTestId('failure-diagnostics-archive-attempts')).not.toBeInTheDocument();
    expect(screen.queryByText('归档阶段')).not.toBeInTheDocument();
    expect(screen.queryByText('归档尝试')).not.toBeInTheDocument();
    expect(screen.queryByText('首次归档错误')).not.toBeInTheDocument();
    expect(screen.queryByText('最近归档错误')).not.toBeInTheDocument();

    // 非终态运行即使带有归档 payload 也不展示归档诊断。
    view.rerender(
      <FailureDiagnostics
        run={makeRun({
          status: 'running',
          error: '生成已完成，归档失败：下载失败',
          providerJob: {
            id: 'job_archive',
            provider: 'newapi',
            status: 'running',
            progress: 100,
            payload: makeArchivePayload(),
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:01:00.000Z',
          },
        })}
      />,
    );
    expect(screen.queryByTestId('failure-diagnostics-archive-attempts')).not.toBeInTheDocument();
    expect(screen.queryByText('归档阶段')).not.toBeInTheDocument();
  });

  it('parses archive failure details defensively from untrusted payloads', () => {
    expect(
      getArchiveFailureDetails(makeRun({ error: 'Authentication failed: invalid api 密钥 (401)' })),
    ).toBeUndefined();

    // 只有自然语言错误时也能识别归档失败，结构化字段为空。
    expect(getArchiveFailureDetails(makeRun({ error: '生成已完成，归档失败：下载失败' }))).toEqual({
      failures: [],
    });

    const run = makeRun({
      providerJob: {
        id: 'job_archive',
        provider: 'newapi',
        status: 'failed',
        progress: 100,
        payload: {
          archiveStage: 'garbage',
          archiveAttempt: 0,
          firstArchiveError: 42,
          lastArchiveError: { message: 'nope' },
          archiveFailures: [
            { attempt: 1, message: '第 1 次失败', at: '2026-08-27T00:00:01.000Z' },
            { attempt: 0, message: '非法尝试号' },
            { attempt: 2.5, message: '非法尝试号' },
            { attempt: 2, message: '' },
            'not-an-object',
            { attempt: 3, message: 'token=extremely-secret' },
            { attempt: 4, message: '第 4 次失败', at: 'not-a-time' },
            { attempt: 6, message: '第 6 次失败' },
            { attempt: 7, message: '第 7 次失败' },
          ],
        },
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:01:00.000Z',
      },
    });
    const details = getArchiveFailureDetails(run);
    expect(details).toBeDefined();
    expect(details?.stage).toBeUndefined();
    expect(details?.attempt).toBeUndefined();
    // 首次归档错误非法时回退到第一条合法尝试。
    expect(details?.firstError).toBe('第 1 次失败');
    // 最近归档错误非法时回退到最后一条合法尝试。
    expect(details?.lastError).toBe('第 7 次失败');
    expect(details?.failures).toHaveLength(5);
    expect(details?.failures.map((failure) => failure.attempt)).toEqual([1, 3, 4, 6, 7]);
    expect(details?.failures[0].at).toBe('2026-08-27T00:00:01.000Z');
    expect(details?.failures[1].at).toBeUndefined();
    expect(details?.failures[1].message).toContain('[已隐藏]');
    expect(details?.failures[1].message).not.toContain('extremely-secret');
  });

  it('derives send status from the run without over-claiming a submission', () => {
    expect(describeRunSendStatus(makeRun({ error: preflightError }))).toBe(
      '未发送（提交前素材预检失败）',
    );
    expect(
      describeRunSendStatus(
        makeRun({
          error: preflightError,
          providerJob: { id: 'job_1', provider: 'newapi', platformJobId: 'platform_123' },
        }),
      ),
    ).toBe('未发送（提交前素材预检失败）');
    expect(
      describeRunSendStatus(
        makeRun({
          providerJob: { id: 'job_1', provider: 'newapi', platformJobId: 'platform_1234567890' },
        }),
      ),
    ).toBe("已提交（上游任务 'platform_123'）");
    expect(
      describeRunSendStatus(makeRun({ providerJob: { id: 'job_1', provider: 'newapi' } })),
    ).toBe("已提交（上游任务 'job_1'）");
    expect(describeRunSendStatus(makeRun({ providerJob: {} }))).toBe('已提交（上游任务）');
    expect(describeRunSendStatus(makeRun({ status: 'cancelled' }))).toBe('已取消');
    expect(describeRunSendStatus(makeRun({}))).toBe('已提交，结果未返回');
  });

  it('classifies failure stages from sanitized error text', () => {
    expect(classifyRunFailureStage(makeRun({ error: preflightError }))).toBe('素材公网可读性预检');
    expect(
      classifyRunFailureStage(makeRun({ error: 'Authentication failed: invalid api 密钥 (401)' })),
    ).toBe('上游认证');
    expect(classifyRunFailureStage(makeRun({ error: 'invalid resolution for model' }))).toBe(
      '上游参数校验',
    );
    expect(classifyRunFailureStage(makeRun({ error: 'fail_to_fetch_task: timeout' }))).toBe(
      '上游生成任务',
    );
    expect(classifyRunFailureStage(makeRun({ error: '结果归档失败：下载超时' }))).toBe('结果归档');
    // 生成成功但归档失败时 providerJob 仍然存在，不能误报为“上游生成任务”。
    expect(
      classifyRunFailureStage(
        makeRun({
          error: `生成已完成，归档失败（第 2 次尝试）：${archiveLatestError}。仅重试归档，不会重新生成`,
          providerJob: {
            id: 'job_archive',
            provider: 'newapi',
            status: 'failed',
            progress: 100,
            createdAt: '2026-08-27T00:00:00.000Z',
            updatedAt: '2026-08-27T00:01:00.000Z',
          },
        }),
      ),
    ).toBe('结果归档');
    expect(classifyRunFailureStage(makeRun({ error: 'boom' }))).toBe('未知阶段');
  });

  it('returns no reference inputs when the snapshot has no frozen assets', () => {
    expect(getRunReferenceInputs(makeRun({}))).toEqual([]);
  });
});
